import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 实时热点模块。
 *
 * 设计取向（用户拍板）：最省事、不占内存——
 * - 不引 TrendRadar（Python/Docker/常驻进程），直接抓各平台公开热榜接口（与 newsnow 同源思路）；
 * - 只保留各平台「最新一版快照」，每次抓取按平台整表替换，数据库体积恒定（百来行）；
 * - 定时每天早上抓一次（手动「立即刷新」随时可用），失败的平台静默跳过、保留上一版数据；
 * - 入库前过滤时政类词条（用途是信息流广告选题，文娱/梗类才是有效素材）。
 */

interface HotItem {
  rank: number;
  title: string;
  hotValue: string | null;
  url: string | null;
}

interface FetchResult {
  items: HotItem[];
}

/** 单平台定义：id 与库中 platform 字段一致 */
export interface PlatformDef {
  id: string;
  name: string;
  fetch: () => Promise<FetchResult>;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 带超时与 UA 的 GET；非 2xx 抛错由上层按平台吞掉 */
async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 热度值统一成「12.3 万」这种短文本 */
function fmtHot(n: number | undefined | null): string | null {
  if (n === undefined || n === null || Number.isNaN(n)) return null;
  if (n >= 10000_0000) return `${(n / 10000_0000).toFixed(1)} 亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return String(Math.round(n));
}

/**
 * 时政类关键词黑名单：命中即丢弃。
 * 用途是信息流广告素材选题，领导人/外交/军事/司法/政策类词条不适用。
 * 词汇刻意选「出现基本就是时政」的高置信词，避免误杀文娱内容（如「歌手」「电影」不碰）。
 * 想放宽/收紧直接增删这张表。
 */
const POLITICS_KEYWORDS = [
  // 领导人与党政机构
  '习近平', '李强', '总理', '总统', '主席', '国务院', '中央政', '中办', '国办',
  '党组织', '党员', '党纪', '纪委', '纪检', '监委', '反腐', '巡视', '组织部长',
  '人大', '政协', '两会', '党代会', '政治局', '书记处', '省委', '市委', '区委',
  // 政策与会议
  '一号文件', '公报', '决议', '意见稿', '征求意见', '白皮书', '纲要', '规划纲要',
  '国务院联防', '新闻发布会', '国新办', '吹风会', '指示', '批示', '部署',
  // 外交与国际政治
  '外交部', '外长', '大使', '访华', '国事访问', '会晤', '峰会', 'G20', 'APEC',
  '金砖', '上合', '东盟', '联合国', '安理会', '制裁', '关税', '贸易战', '中美', '中俄',
  '中日', '中韩', '两岸', '台海', '统一大业', '一国两制', '涉港', '涉台', '涉疆', '涉藏',
  // 军事与安全
  '国防部', '解放军', '军演', '演习', '导弹', '核武', '火箭军', '东部战区', '南部战区',
  '台军', '美军', '北约', '无人机袭击', '停火', '停战', '宣战', '袭击',
  // 国际热点国家/地区（出现即大概率国际时政）
  '乌克兰', '俄罗斯', '以色列', '巴勒斯坦', '加沙', '伊朗', '叙利亚', '朝鲜', '韩国军方',
  '白宫', '五角大楼', '克宫', '克里姆林', '首相', '议会', '国会', '大选', '选举', '执政党',
  '脱欧', '政变', '戒严',
  // 外国政要（实测 2026-11-17：特朗普/金正恩类词条常上头条榜）
  '特朗普', '金正恩', '普京', '拜登', '泽连斯基', '内塔尼亚胡', '马克龙', '万斯', '哈里斯',
  '安倍', '默克尔', '卡斯特罗', '国宴',
  '特首', '行政长官', '李家超', '岑浩辉',
  // 国别表态类（「中方回应/美方称/日方」句式基本都属时政）
  '中方', '美方', '朝方', '日方', '韩方', '俄方', '伊方', '以外交',
  // 司法与案件通报
  '最高法', '最高检', '公安部', '法院', '检察院', '案情通报', '警方通报',
  '刑拘', '批捕', '开庭', '宣判', '判刑', '死刑', '判决书',
];

/** 标题命中时政黑名单则过滤掉；返回是否被过滤 */
function isPolitical(title: string): boolean {
  return POLITICS_KEYWORDS.some((k) => title.includes(k));
}

export const HOT_PLATFORMS: PlatformDef[] = [
  {
    id: 'weibo',
    name: '微博热搜',
    // 实测：不带 Referer + X-Requested-With 会 403（2026-11-17）
    fetch: async () => {
      const j = await getJson('https://weibo.com/ajax/side/hotSearch', {
        Referer: 'https://weibo.com',
        'X-Requested-With': 'XMLHttpRequest',
      });
      const list: any[] = j?.data?.realtime ?? [];
      const items: HotItem[] = list
        .filter((r) => r?.word && !r.is_ad)
        .slice(0, 50)
        .map((r, i) => ({
          rank: i + 1,
          title: String(r.word),
          hotValue: fmtHot(Number(r.num)),
          url: r.word_scheme ? `https://s.weibo.com/weibo?q=${encodeURIComponent(r.word_scheme)}` : null,
        }));
      return { items };
    },
  },
  {
    id: 'baidu',
    name: '百度热搜',
    // 实测（2026-11-17）：接口只回 tabTextList 纯榜单（word+url，无热度值），名次即热度序
    fetch: async () => {
      const j = await getJson('https://top.baidu.com/api/board?platform=wise&tab=realtime', {
        Referer: 'https://top.baidu.com/board?tab=realtime',
      });
      const raw = j?.data?.cards?.[0]?.content?.[0]?.content;
      const list: any[] = raw ? (Array.isArray(raw) ? raw : Object.values(raw)) : [];
      const items: HotItem[] = list
        .map((r, i) => ({
          rank: i + 1,
          title: String(r?.word ?? '').trim(),
          hotValue: r?.hotScore ? fmtHot(Number(r.hotScore)) : null,
          url: r?.url ?? (r?.word ? `https://www.baidu.com/s?wd=${encodeURIComponent(r.word)}` : null),
        }))
        .filter((x) => x.title)
        .slice(0, 50);
      return { items };
    },
  },
  {
    id: 'toutiao',
    name: '今日头条',
    fetch: async () => {
      const j = await getJson('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc');
      const list: any[] = j?.data ?? [];
      const items: HotItem[] = list
        .filter((r) => r?.Title)
        .slice(0, 50)
        .map((r, i) => ({
          rank: i + 1,
          title: String(r.Title),
          hotValue: fmtHot(Number(r.HotValue)),
          url: r.Url ? String(r.Url) : null,
        }));
      return { items };
    },
  },
  {
    id: 'bilibili',
    name: 'B站热搜',
    fetch: async () => {
      const j = await getJson('https://api.bilibili.com/x/web-interface/search/square?limit=50');
      const list: any[] = j?.data?.trending?.list ?? [];
      const items: HotItem[] = list
        .filter((r) => r?.keyword)
        .slice(0, 50)
        .map((r, i) => ({
          rank: Number(r.position) || i + 1,
          title: String(r.show_name ?? r.keyword),
          hotValue: fmtHot(Number(r.hot_score)),
          url: r.link ? String(r.link) : `https://search.bilibili.com/all?keyword=${encodeURIComponent(r.keyword)}`,
        }));
      return { items };
    },
  },
  {
    id: 'zhihu',
    name: '知乎热榜',
    fetch: async () => {
      const j = await getJson('https://api.zhihu.com/topstory/hot-list?limit=50');
      const list: any[] = j?.data ?? [];
      const items: HotItem[] = list
        .slice(0, 50)
        .map((r, i) => {
          const t = r?.target ?? {};
          const title = String(t.title ?? t.title_area?.text ?? '').trim();
          const api = typeof t.url === 'string' ? t.url : '';
          // api.zhihu.com/questions/123 → www.zhihu.com/questions/123
          const web = api.replace('://api.zhihu.com', '://www.zhihu.com');
          return {
            rank: i + 1,
            title,
            hotValue: typeof r.detail_text === 'string' ? r.detail_text.replace('万热度', ' 万').replace('亿热度', ' 亿') : null,
            url: web || null,
          };
        })
        .filter((x) => x.title);
      return { items };
    },
  },
];

@Injectable()
export class HotTopicsService {
  private readonly logger = new Logger(HotTopicsService.name);
  private refreshing: Promise<{ ok: string[]; failed: string[] }> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** 定时刷新：每天 08:00 抓一次（首次 GET 空库时也会兜底抓；页面「立即刷新」随时可用） */
  @Cron('0 8 * * *')
  async scheduledRefresh(): Promise<void> {
    await this.refresh();
  }

  /** 抓取全部平台并整表替换；并发执行，单平台失败不影响其他平台。进行中时复用同一 Promise */
  async refresh(): Promise<{ ok: string[]; failed: string[] }> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<{ ok: string[]; failed: string[] }> {
    const ok: string[] = [];
    const failed: string[] = [];
    await Promise.all(
      HOT_PLATFORMS.map(async (p) => {
        try {
          const { items } = await p.fetch();
          // 过滤时政类后重新连续编名次（保留榜单的热度顺序，去掉中间的空洞）
          const kept = items.filter((it) => !isPolitical(it.title));
          const dropped = items.length - kept.length;
          if (dropped > 0) this.logger.log(`[${p.name}] 过滤时政词条 ${dropped} 条，剩 ${kept.length} 条`);
          if (kept.length === 0) throw new Error('返回空榜单');
          const fetchedAt = new Date();
          const data = kept.map((it, i) => ({
            platform: p.id,
            rank: i + 1,
            title: it.title.slice(0, 300),
            hotValue: it.hotValue,
            url: it.url,
            fetchedAt,
          }));
          await this.prisma.$transaction([
            this.prisma.hotTopicItem.deleteMany({ where: { platform: p.id } }),
            this.prisma.hotTopicItem.createMany({ data }),
          ]);
          ok.push(p.id);
        } catch (err) {
          failed.push(p.id);
          this.logger.warn(`热点抓取失败 [${p.name}]：${(err as Error).message}`);
        }
      }),
    );
    return { ok, failed };
  }

  /** 读快照：库里没有任何数据时自动先抓一次（首次打开页面就有内容） */
  async list(refresh = false): Promise<{
    updatedAt: string | null;
    platforms: Array<{ id: string; name: string; fetchedAt: string | null; error?: string }>;
    items: Array<{ platform: string; rank: number; title: string; hotValue: string | null; url: string | null }>;
  }> {
    if (refresh) await this.refresh();

    let rows = await this.prisma.hotTopicItem.findMany({ orderBy: [{ platform: 'asc' }, { rank: 'asc' }] });
    if (rows.length === 0) {
      await this.refresh();
      rows = await this.prisma.hotTopicItem.findMany({ orderBy: [{ platform: 'asc' }, { rank: 'asc' }] });
    }

    const byPlatform = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = byPlatform.get(r.platform) ?? [];
      arr.push(r);
      byPlatform.set(r.platform, arr);
    }

    const platforms = HOT_PLATFORMS.map((p) => {
      const arr = byPlatform.get(p.id);
      return {
        id: p.id,
        name: p.name,
        fetchedAt: arr?.[0]?.fetchedAt?.toISOString() ?? null,
        error: arr?.length ? undefined : '暂无数据（抓取失败或尚未抓取）',
      };
    });

    const latest = rows.reduce<string | null>((acc, r) => {
      const iso = r.fetchedAt?.toISOString() ?? null;
      return !acc || (iso && iso > acc) ? iso : acc;
    }, null);

    return {
      updatedAt: latest,
      platforms,
      items: rows.map((r) => ({
        platform: r.platform,
        rank: r.rank,
        title: r.title,
        hotValue: r.hotValue,
        url: r.url,
      })),
    };
  }
}
