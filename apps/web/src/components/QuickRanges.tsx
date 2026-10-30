import dayjs, { Dayjs } from 'dayjs';

/* ------------------------------------------------------------------
 * 日期快捷预设（盯盘 / 素材 等所有看板共用）：
 *   今天 / 昨天 / 3 / 7 / 15 / 30 天 / 上周 / 本月 / 上月
 *
 * 统一收进日期组件内部（RangePicker 弹出面板左侧的预设栏），
 * 不再在工具栏上平铺一排按钮，保持工具栏干净。
 * ------------------------------------------------------------------ */

/** 周一为一周开始（dayjs 默认从周日算，中国习惯周一，手动换算避免引插件） */
function mondayOf(d: Dayjs): Dayjs {
  return d.subtract((d.day() + 6) % 7, 'day');
}

export interface QuickRangeDef {
  label: string;
  build: () => [Dayjs, Dayjs];
}

export const QUICK_RANGES: QuickRangeDef[] = [
  { label: '今天', build: () => [dayjs(), dayjs()] },
  { label: '昨天', build: () => [dayjs().subtract(1, 'day'), dayjs().subtract(1, 'day')] },
  { label: '近3天', build: () => [dayjs().subtract(2, 'day'), dayjs()] },
  { label: '近7天', build: () => [dayjs().subtract(6, 'day'), dayjs()] },
  { label: '近15天', build: () => [dayjs().subtract(14, 'day'), dayjs()] },
  { label: '近30天', build: () => [dayjs().subtract(29, 'day'), dayjs()] },
  {
    label: '上周',
    build: () => {
      const thisMonday = mondayOf(dayjs());
      return [thisMonday.subtract(7, 'day'), thisMonday.subtract(1, 'day')];
    },
  },
  { label: '本月', build: () => [dayjs().startOf('month'), dayjs()] },
  {
    label: '上月',
    build: () => {
      const first = dayjs().date(1).subtract(1, 'month');
      return [first, first.endOf('month')];
    },
  },
];

/**
 * antd RangePicker 的 presets（日期组件面板内的快捷项）。
 *
 * minDate 传入本地数据最早日期时，起点早于它的快捷项直接不展示
 * —— 选了也查不出东西，不如不给选（比「点了才知道空」体验好）。
 * 「今天」永远保留，保证至少有一个可用项。
 */
export function quickPresets(minDate?: Dayjs | null): Array<{ label: string; value: () => [Dayjs, Dayjs] }> {
  const usable = QUICK_RANGES.filter((r) => {
    if (r.label === '今天' || !minDate) return true;
    return !r.build()[0].isBefore(minDate, 'day');
  });
  return usable.map((r) => ({ label: r.label, value: r.build }));
}
