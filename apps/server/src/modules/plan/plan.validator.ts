import { PlanRow, PlanRowIssue } from '@wkbd/shared';

const LEVELS: Record<string, PlanRowIssue['level']> = {
  campaignName: 'CAMPAIGN',
  campaignType: 'CAMPAIGN',
  campaignDayBudgetYuan: 'CAMPAIGN',
  unitName: 'UNIT',
  bidType: 'UNIT',
  bidYuan: 'UNIT',
  cpaBidYuan: 'UNIT',
  ocpxActionType: 'UNIT',
  sceneIds: 'UNIT',
  unitType: 'UNIT',
  beginTime: 'UNIT',
  endTime: 'UNIT',
  unitDayBudgetYuan: 'UNIT',
  appId: 'UNIT',
  packageId: 'UNIT',
  webUriType: 'UNIT',
  url: 'UNIT',
  siteId: 'UNIT',
  groupId: 'UNIT',
  schemaUri: 'UNIT',
  seriesId: 'UNIT',
  episodeId: 'UNIT',
  jingleBellId: 'UNIT',
  liveUserId: 'UNIT',
  creativeName: 'CREATIVE',
  materialType: 'CREATIVE',
  photoId: 'CREATIVE',
  imageTokens: 'CREATIVE',
  actionBarText: 'CREATIVE',
  description: 'CREATIVE',
};

/** 出价合法区间（官方：CPC 0.2~100 元；OCPM 按优化目标分档，这里取宽区间兜底） */
const BID_MIN_YUAN = 0.2;
const BID_MAX_YUAN = 100;
const OCPM_BID_MIN_YUAN = 0.1;
const OCPM_BID_MAX_YUAN = 3000;

/** 平台日期格式：yyyy-MM-dd */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 本地校验器。
 *
 * 存在的意义：平台的参数错误只在**实际提交时**才返回，一条错要等一次网络往返。
 * 100 行 × 3 层 = 300 次调用，如果参数错在第 1 行，用户要等几分钟才看到报错。
 * 所以必须在提交前把「必然失败」的行拦下来。
 *
 * 注意边界：这里**不做业务判断的替代**（比如某优化目标是否对某账户开放、
 * 某素材类型是否在该账户白名单里），那些只有平台能回答，留给提交后的错误回传。
 */
export function validateRows(rows: PlanRow[]): PlanRowIssue[] {
  const issues: PlanRowIssue[] = [];
  const seenNames = new Map<string, Set<string>>();

  for (const row of rows) {
    const push = (field: string, message: string, severity: 'ERROR' | 'WARN' = 'ERROR') => {
      issues.push({
        rowNo: row.rowNo,
        field,
        level: LEVELS[field] ?? 'ROW',
        message,
        severity,
      });
    };

    /* ——— 账户 ——— */
    if (!row.advertiserId || !/^\d+$/.test(String(row.advertiserId).trim())) {
      push('advertiserId', '未指定广告账户或账户 ID 非数字', 'ERROR');
    }

    /* ——— 计划层 ——— */
    if (!row.campaignName?.trim()) {
      push('campaignName', '计划名称不能为空');
    } else if (row.campaignName.length > 100) {
      push('campaignName', '计划名称超过 100 字符');
    }

    if (!row.campaignType) {
      push('campaignType', '必须选择营销目标');
    }

    if (row.campaignDayBudgetYuan != null && row.campaignDayBudgetYuan !== 0) {
      const yuan = row.campaignDayBudgetYuan;
      if (yuan < 500 || yuan > 100000000) {
        push('campaignDayBudgetYuan', '计划日预算须 ≥ 500 元（填 0 表示不限）');
      }
    }

    /* ——— 广告组层 ——— */
    if (!row.unitName?.trim()) {
      push('unitName', '广告组名称不能为空');
    } else if (row.unitName.length > 100) {
      push('unitName', '广告组名称超过 100 字符');
    }

    // 每条计划的组数：1~50（>1 时服务端展开成 1 计划 + N 组）
    const unitsPer = row.unitsPerCampaign ?? 1;
    if (!Number.isInteger(unitsPer) || unitsPer < 1 || unitsPer > 50) {
      push('unitName', '每个计划的广告组数须为 1~50 的整数');
    }

    if (!row.bidType) {
      push('bidType', '必须选择出价类型');
    } else if (row.bidType === 2) {
      // CPC：bid 必填
      if (row.bidYuan == null) {
        push('bidYuan', 'CPC 出价类型下必须填写出价');
      } else if (row.bidYuan < BID_MIN_YUAN || row.bidYuan > BID_MAX_YUAN) {
        push('bidYuan', `CPC 出价须在 ${BID_MIN_YUAN}~${BID_MAX_YUAN} 元之间`);
      }
    } else if (row.bidType === 10 || row.bidType === 12) {
      // OCPM / MCB：cpa_bid 与优化目标必填
      if (row.cpaBidYuan == null) {
        push('cpaBidYuan', 'OCPM / MCB 出价类型下必须填写出价');
      } else if (row.cpaBidYuan < OCPM_BID_MIN_YUAN || row.cpaBidYuan > OCPM_BID_MAX_YUAN) {
        push('cpaBidYuan', `转化出价须在 ${OCPM_BID_MIN_YUAN}~${OCPM_BID_MAX_YUAN} 元之间`);
      }
      if (!row.ocpxActionType) {
        push('ocpxActionType', 'OCPM / MCB 出价类型下必须选择优化目标');
      }
    }

    if (row.unitDayBudgetYuan != null && row.unitDayBudgetYuan !== 0) {
      const yuan = row.unitDayBudgetYuan;
      if (yuan < 100 || yuan > 100000000) {
        push('unitDayBudgetYuan', '广告组日预算须 ≥ 100 元（填 0 表示不限）');
      }
      // 组预算不得低于出价（官方校验规则）
      const bid = row.bidType === 2 ? row.bidYuan : row.cpaBidYuan;
      if (bid != null && yuan > 0 && bid > yuan) {
        push('unitDayBudgetYuan', '组预算不能低于该组出价');
      }
    }

    if (!Array.isArray(row.sceneIds) || row.sceneIds.length === 0) {
      push('sceneIds', '必须选择至少一个资源位置');
    }

    if (!row.unitType) {
      push('unitType', '必须选择创意制作方式');
    }

    if (!row.beginTime) {
      push('beginTime', '必须填写投放开始日期');
    } else if (!DATE_RE.test(row.beginTime)) {
      push('beginTime', '日期格式须为 yyyy-MM-dd');
    } else if (row.beginTime < today()) {
      push('beginTime', '投放开始时间不能早于今天');
    }

    if (row.endTime) {
      if (!DATE_RE.test(row.endTime)) {
        push('endTime', '日期格式须为 yyyy-MM-dd');
      } else if (row.beginTime && row.endTime < row.beginTime) {
        push('endTime', '结束时间不能早于开始时间');
      }
    }

    if (row.scheduleTime) {
      if (!/^[01]{168}$/.test(row.scheduleTime)) {
        push('scheduleTime', '投放时段必须是 168 位 0/1 字符串（7×24 小时）');
      }
    }

    /* ——— 随营销目标变化的链路参数 ——— */
    validateByCampaignType(row, push);

    /* ——— 创意层 ——— */
    if (!row.creativeName?.trim()) {
      push('creativeName', '创意名称不能为空');
    } else if (row.creativeName.length > 100) {
      push('creativeName', '创意名称超过 100 字符');
    }

    if (!row.materialType) {
      push('materialType', '必须选择素材类型');
    } else if ([1, 2, 11].includes(row.materialType) && !row.photoId) {
      push('photoId', '视频类素材必须提供视频 ID');
    } else if ([5, 6, 9].includes(row.materialType) && !(row.imageTokens?.length)) {
      push('imageTokens', '图片类素材必须提供图片 token');
    } else if (row.materialType === 10 && (row.imageTokens?.length ?? 0) !== 3) {
      push('imageTokens', '组图创意必须刚好 3 张图片');
    }

    /* ——— 创意组模型：一行多视频 ——— */
    if (row.creativeVideos?.length) {
      if (row.creativeVideos.length > 15) {
        push('creativeVideos', '单个广告组下的视频创意不能超过 15 个');
      }
      row.creativeVideos.forEach((v, i) => {
        if (!v.photoId || !/^\d+$/.test(String(v.photoId).trim())) {
          push('photoId', `第 ${i + 1} 个创意的视频 ID 无效`);
        }
        if (v.description && v.description.length > 30) {
          push('description', `第 ${i + 1} 个创意的广告语超过 30 字符`);
        }
      });
    }

    if (!row.actionBarText?.trim()) {
      push('actionBarText', '行动号召文案不能为空');
    }

    if (row.description && row.description.length > 30) {
      push('description', '广告语不能超过 30 字符');
    }

    if ((row.creativeTags?.length ?? 0) > 10) {
      push('creativeTags', '创意标签最多 10 个');
    }
    if (row.creativeTags?.some((t) => !t || t.length > 10)) {
      push('creativeTags', '单个创意标签不能为空且不超过 10 字符');
    }

    /* ——— 搜索广告（计划 ad_type=1）——— */
    // 关键词在组创建成功后经 v2/word_info/create 下发：单组 ≤1000 个、单词 ≤20 字（官方硬约束）
    if (row.adType === 1 && row.searchKeywords?.length) {
      if (row.searchKeywords.length > 1000) {
        push('searchKeywords', '单个广告组关键词不能超过 1000 个');
      }
      const tooLong = row.searchKeywords.find((w) => w.trim().length > 20);
      if (tooLong) {
        push('searchKeywords', `关键词「${tooLong.trim().slice(0, 10)}…」超过 20 字符（不支持制表符/换行/Emoji）`);
      }
    }
    // 否定词：短语 / 精确各 ≤200 个（官方硬约束）
    if ((row.searchNegPhrase?.length ?? 0) > 200) {
      push('searchKeywords', '短语否定词不能超过 200 个');
    }
    if ((row.searchNegExact?.length ?? 0) > 200) {
      push('searchKeywords', '精确否定词不能超过 200 个');
    }

    /* ——— 同账户内的名称重复（平台会直接拒绝）——— */
    const scope = `${row.advertiserId}|${row.campaignName}`;
    if (row.campaignName) {
      const set = seenNames.get(scope) ?? new Set<string>();
      if (set.has(row.campaignName)) {
        push('campaignName', '同一账户下计划名称重复，平台会拒绝');
      }
      set.add(row.campaignName);
      seenNames.set(scope, set);
    }
  }

  return issues;
}

/** 按营销目标校验链路参数——这是「一套模板走天下」最容易漏的地方 */
function validateByCampaignType(
  row: PlanRow,
  push: (field: string, message: string, severity?: 'ERROR' | 'WARN') => void,
): void {
  switch (row.campaignType) {
    case 2:
    case 7:
      if (!row.appId) push('appId', '应用安装/活跃必须填写应用 ID');
      if (!row.packageId) {
        push('packageId', '新版应用中心投放需填写应用包 ID（老版应用可不填）', 'WARN');
      }
      break;

    case 5:
      if (!row.webUriType) {
        push('webUriType', '销售线索必须选择落地页形态');
      } else if (row.webUriType === 1 && !row.url) {
        push('url', '自有链接形态必须填写投放链接');
      } else if (row.webUriType === 2 && !row.siteId) {
        push('siteId', '建站落地页形态必须填写建站 ID');
      } else if (row.webUriType === 3 && !row.groupId) {
        push('groupId', '程序化落地页形态必须填写程序化落地页 ID');
      }
      break;

    case 30:
      if (!row.seriesId) push('seriesId', '短剧推广必须填写短剧 ID');
      if (!row.episodeId) push('episodeId', '短剧推广必须填写剧集 ID');
      if (!row.liveUserId) push('liveUserId', '短剧推广必须填写短剧作者 ID');
      break;

    case 16:
      if (!row.jingleBellId) push('jingleBellId', '直播推广必须填写小铃铛组件 ID');
      if (!row.liveUserId) push('liveUserId', '直播推广必须填写主播 ID');
      break;

    case 35:
      if (!row.webUriType && !row.url) {
        push('webUriType', '电商下单推广需明确落地页/标的物', 'WARN');
      }
      break;

    default:
      break;
  }
}

function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
