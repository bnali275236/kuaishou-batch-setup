import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 实时热点模块。
 *
 * 设计取向（用户拍板）：最省事、不占内存——
 * - 不引 TrendRadar（Python/Docker/常驻进程），直接抓各平台公开热榜接口（与 newsnow 同源思路）；
 * - 只保留各平台「最新一版快照」，每次抓取按平台整表替换，数据库体积恒定（百来行）；
 * - 定时 10 分钟一次，失败的平台静默跳过、保留上一版数据。
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

  /** 定时刷新：每 10 分钟（服务启动后由首次 GET 兜底拉一次） */
  @Cron('*/10 * * * *')
  async scheduledRefresh(): Promise<void> {
    await this.refresh();
  }  /** 抓取全部平台并整表替换；并发执行，单平台失败不影响其他平台。进行中时复用同一 Promise */
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
          if (items.length === 0) throw new Error('返回空榜单');
          const fetchedAt = new Date();
          const data = items.map((it) => ({
            platform: p.id,
            rank: it.rank,
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
