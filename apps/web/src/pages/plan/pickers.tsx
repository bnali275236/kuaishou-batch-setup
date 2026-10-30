import { useEffect, useMemo, useRef, useState } from 'react';
import dayjs, { Dayjs } from 'dayjs';
import {
  Button,
  Checkbox,
  DatePicker,
  Dropdown,
  Empty,
  Input,
  Modal,
  Pagination,
  Radio,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { HistoryOutlined, QuestionCircleOutlined, SearchOutlined } from '@ant-design/icons';

/**
 * 对照磁力引擎官方「选择素材 / 落地页」弹窗做的轻量复刻。
 *
 * 与官方的差异（刻意的）：
 * - 不做魔搜 / 收藏夹等非素材库 tab，我们只同步视频库；
 * - 消耗指标来自素材维度实时报表，平台只开放近 7 天（起始 ≥ T-7），
 *   所以口径是「今日 / 昨日 / 近 7 天」；30 天与历史累计要等异步报表。
 */

/** 与服务端 PlanAssetsService 对齐的资产条目 */
export interface AssetItem {
  id: string;
  name: string;
  cover?: string;
  status?: number;
  /** 上传时间 yyyy-MM-dd HH:mm:ss */
  uploadTime?: string;
  /** 今日消耗（元） */
  costToday?: number;
  /** 昨日消耗（元） */
  costYesterday?: number;
  /** 近 7 天消耗（元） */
  cost7d?: number;
  /** 原始条目（应用选择时要取 package_id 等扩展字段） */
  raw?: Record<string, unknown>;
}

/** 主色：快手橙，向导里的选中态统一用它 */
export const BRAND = '#FF4F00';

/* ------------------------------------------------------------------
 * 芯片选项组：官方页面的单选/多选都是「小蓝块」，用 CheckableTag 复刻
 * ---------------------------------------------------------------- */
export function ChipGroup<T extends string | number>(props: {
  options: Array<{ value: T; label: string; disabled?: boolean; tip?: string }>;
  value: T | T[] | null;
  onChange: (v: T | T[]) => void;
  multiple?: boolean;
}) {
  const { options, value, onChange, multiple } = props;
  const values = (Array.isArray(value) ? value : value == null ? [] : [value]) as T[];

  const render = (opt: { value: T; label: string; disabled?: boolean; tip?: string }) => {
    const checked = values.includes(opt.value);
    const tag = (
      <Tag.CheckableTag
        key={String(opt.value)}
        checked={checked}
        onChange={() => {
          if (opt.disabled) return;
          if (multiple) {
            const next = checked ? values.filter((v) => v !== opt.value) : [...values, opt.value];
            onChange(next);
          } else {
            onChange(opt.value);
          }
        }}
        style={{
          border: `1px solid ${checked ? BRAND : '#E8E6E1'}`,
          borderRadius: 4,
          padding: '2px 12px',
          fontSize: 13,
          cursor: opt.disabled ? 'not-allowed' : 'pointer',
          opacity: opt.disabled ? 0.5 : 1,
          background: checked ? '#FFF1E8' : '#fff',
          color: checked ? BRAND : '#37352F',
        }}
      >
        {opt.label}
      </Tag.CheckableTag>
    );
    return opt.tip ? (
      <Tooltip key={String(opt.value)} title={opt.tip}>
        {tag}
      </Tooltip>
    ) : (
      tag
    );
  };

  return <Space wrap size={6}>{options.map(render)}</Space>;
}

/* ------------------------------------------------------------------
 * 官方式「左侧标签 + 右侧控件」行
 * ---------------------------------------------------------------- */
export function FormRow(props: {
  label: string;
  tip?: string;
  children: React.ReactNode;
  /** 错误定位锚点：fld-<field> 供报错跳转 scrollIntoView */
  rowId?: string;
  /** 定位高亮：报错跳转后短暂橙色描边 */
  flash?: boolean;
}) {
  const { label, tip, children, rowId, flash } = props;
  return (
    <div
      id={rowId}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        marginBottom: 8,
        padding: '2px 6px',
        marginInline: -6,
        borderRadius: 6,
        border: `1px solid ${flash ? BRAND : 'transparent'}`,
        background: flash ? '#FFF9F5' : 'transparent',
        boxShadow: flash ? '0 0 0 2px rgba(255,79,0,0.25)' : 'none',
        transition: 'box-shadow 0.3s, background 0.3s, border-color 0.3s',
      }}
    >
      <div style={{ width: 108, flexShrink: 0, fontSize: 13, color: '#37352F', paddingTop: 4 }}>
        <span>
          {label}
          {tip && (
            <Tooltip title={tip} placement="topLeft">
              <QuestionCircleOutlined
                style={{ fontSize: 11, color: '#B8B5AC', marginLeft: 3, cursor: 'help' }}
              />
            </Tooltip>
          )}
        </span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------
 * 字段历史记忆：手动填写过的值存 localStorage，下次一键选回
 * ---------------------------------------------------------------- */
const HIST_PREFIX = 'wkbd_hist_';
const HIST_MAX = 20;

/** 读某字段的填写历史（最近在前） */
export function readHistory(key: string): string[] {
  try {
    const raw = localStorage.getItem(HIST_PREFIX + key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch {
    return [];
  }
}

/** 记一笔（去重、置顶、截断） */
export function pushHistory(key: string, value: string | number | null | undefined): void {
  const v = value == null ? '' : String(value).trim();
  if (!v) return;
  try {
    const list = readHistory(key).filter((x) => x !== v);
    list.unshift(v);
    localStorage.setItem(HIST_PREFIX + key, JSON.stringify(list.slice(0, HIST_MAX)));
  } catch {
    /* localStorage 不可用时静默跳过 */
  }
}

/**
 * 历史值下拉按钮：放在输入框旁边，点开列出该字段最近填过的值，
 * 点选即回填。读操作实时读 localStorage，所以刚记完就能看到。
 */
export function HistoryDropdown(props: { histKey: string; onPick: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const items = readHistory(props.histKey).map((v) => ({ key: v, label: v }));
  if (items.length === 0) return null;
  return (
    <Dropdown
      menu={{
        items,
        onClick: ({ key }) => {
          props.onPick(key);
          setOpen(false);
        },
        style: { maxHeight: 300, overflow: 'auto' },
      }}
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setTick((t) => t + 1); // 每次打开前重读历史
      }}
      trigger={['click']}
    >
      <Tooltip title="填入历史值">
        <Button size="small" icon={<HistoryOutlined />} style={{ color: '#888780' }} data-tick={tick} />
      </Tooltip>
    </Dropdown>
  );
}
/* ------------------------------------------------------------------
 * 素材选择弹窗（对照官方「素材库」：筛选栏 + 小封面网格 + 指标 + 分页）
 * ---------------------------------------------------------------- */

type SortKey = 'cost7d' | 'costYesterday' | 'costToday' | 'uploadTime';

const PAGE_SIZE_OPTIONS = ['10', '30', '50'];

/** 消耗展示：0.01 元精度，无数据显示 — */
function fmtCost(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  if (n === 0) return '¥0';
  return `¥${n >= 100 ? Math.round(n) : Math.round(n * 100) / 100}`;
}

export function VideoPickerModal(props: {
  open: boolean;
  onClose: () => void;
  videos: AssetItem[];
  loading?: boolean;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { open, onClose, videos, loading, selected, onChange } = props;
  const [keyword, setKeyword] = useState('');
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>('cost7d');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    if (open) setPage(1);
  }, [open, keyword, dateRange, sortBy, pageSize]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const [start, end] = dateRange ?? [null, null];
    const startTime = start ? start.startOf('day').valueOf() : null;
    const endTime = end ? end.endOf('day').valueOf() : null;

    const rows = videos.filter((v) => {
      if (kw && !v.name.toLowerCase().includes(kw) && !v.id.includes(kw)) return false;
      if (startTime !== null && v.uploadTime) {
        const t = dayjs(v.uploadTime).valueOf();
        if (t < startTime || (endTime !== null && t > endTime)) return false;
      }
      return true;
    });

    const num = (x: number | undefined) => (x === undefined ? -1 : x);
    return rows.sort((a, b) => {
      if (sortBy === 'uploadTime') {
        return (b.uploadTime ?? '').localeCompare(a.uploadTime ?? '');
      }
      // 无消耗数据的素材沉底，让「消耗排名前 N」永远在前排
      return num(b[sortBy]) - num(a[sortBy]);
    });
  }, [videos, keyword, dateRange, sortBy]);

  const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  return (
    <Modal
      title={
        <Space size={12}>
          <span>选择素材</span>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            手动选取素材 · 已选 {selected.length} 个
          </Typography.Text>
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={900}
      footer={
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Typography.Link
            style={{ fontSize: 12 }}
            onClick={(e) => {
              e.preventDefault();
              onChange([]);
            }}
          >
            清空已选
          </Typography.Link>
          <div style={{ flex: 1 }} />
          <Button type="primary" onClick={onClose}>
            确定
          </Button>
        </div>
      }
    >
      {/* 筛选栏：名称搜索 + 上传时间 + 排序 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: '#B8B5AC' }} />}
          placeholder="搜索素材名称或 ID"
          style={{ width: 220 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <DatePicker.RangePicker
          size="middle"
          style={{ width: 250 }}
          placeholder={['上传开始', '上传结束']}
          value={dateRange}
          onChange={(v) => setDateRange(v as [Dayjs | null, Dayjs | null] | null)}
          allowClear
        />
        <Select
          style={{ width: 190 }}
          value={sortBy}
          onChange={(v) => setSortBy(v as SortKey)}
          options={[
            { value: 'cost7d', label: '按近7天消耗 高→低' },
            { value: 'costYesterday', label: '按昨日消耗 高→低' },
            { value: 'costToday', label: '按今日消耗 高→低' },
            { value: 'uploadTime', label: '按上传时间 新→旧' },
          ]}
        />
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
        消耗来自素材维度实时报表，平台仅开放近 7 天（30 天 / 历史累计需异步报表，暂未接入）；无消耗的素材排在末尾。
      </Typography.Text>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin />
        </div>
      ) : filtered.length === 0 ? (
        <Empty
          description={videos.length === 0 ? '账户里没有可用视频，先点「同步素材」' : '没有符合筛选条件的素材'}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          style={{ padding: 24 }}
        />
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(118px, 1fr))',
              gap: 8,
              maxHeight: 430,
              overflowY: 'auto',
              padding: '2px',
            }}
          >
            {pageItems.map((v) => {
              const checked = selected.includes(v.id);
              return (
                <Tooltip
                  key={v.id}
                  title={`${v.name || v.id}（ID: ${v.id}）${v.uploadTime ? ` · 上传于 ${v.uploadTime}` : ''}`}
                >
                  <div
                    onClick={() => toggle(v.id)}
                    style={{
                      cursor: 'pointer',
                      border: `1px solid ${checked ? BRAND : '#E8E6E1'}`,
                      borderRadius: 6,
                      overflow: 'hidden',
                      background: '#fff',
                    }}
                  >
                    <div style={{ position: 'relative', height: 128, background: '#F5F4F0' }}>
                      {v.cover ? (
                        <img
                          src={v.cover}
                          alt={v.name || v.id}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          loading="lazy"
                        />
                      ) : (
                        <div
                          style={{
                            width: '100%',
                            height: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 11,
                            color: '#888780',
                          }}
                        >
                          {(v.name || v.id).slice(0, 10)}
                        </div>
                      )}
                      <div
                        style={{
                          position: 'absolute',
                          top: 4,
                          left: 4,
                          background: 'rgba(0,0,0,0.45)',
                          borderRadius: 4,
                          width: 16,
                          height: 16,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Checkbox checked={checked} style={{ lineHeight: 1 }} />
                      </div>
                    </div>
                    <div style={{ padding: '4px 6px 6px' }}>
                      <div
                        style={{
                          fontSize: 12,
                          color: '#37352F',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {v.name || v.id}
                      </div>
                      <div style={{ fontSize: 11, color: '#37352F', marginTop: 2 }}>
                        <span style={{ color: BRAND, fontWeight: 600 }}>
                          7天 {fmtCost(v.cost7d)}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: '#888780', marginTop: 1 }}>
                        昨日 {fmtCost(v.costYesterday)} · 今日 {fmtCost(v.costToday)}
                      </div>
                      {v.uploadTime && (
                        <div
                          style={{
                            fontSize: 10,
                            color: '#B8B5AC',
                            marginTop: 1,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {v.uploadTime}
                        </div>
                      )}
                    </div>
                  </div>
                </Tooltip>
              );
            })}
          </div>
          {/* 分页：右下角，可切每页条数；左侧「本页全选」一键勾选/取消当前页 */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              alignItems: 'center',
              marginTop: 12,
              gap: 12,
            }}
          >
            <Typography.Link
              style={{ fontSize: 12, marginRight: 'auto' }}
              onClick={(e) => {
                e.preventDefault();
                const ids = pageItems.map((v) => v.id);
                if (ids.length === 0) return;
                if (ids.every((id) => selected.includes(id))) {
                  const drop = new Set(ids);
                  onChange(selected.filter((id) => !drop.has(id)));
                } else {
                  onChange([...selected, ...ids.filter((id) => !selected.includes(id))]);
                }
              }}
            >
              {pageItems.length > 0 && pageItems.every((v) => selected.includes(v.id))
                ? '取消本页'
                : `本页全选（${pageItems.length}）`}
            </Typography.Link>
            <Pagination
              size="small"
              current={page}
              pageSize={pageSize}
              total={filtered.length}
              onChange={(p, ps) => {
                setPage(p);
                setPageSize(ps);
              }}
              showSizeChanger
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              showTotal={(t) => `共 ${t} 条`}
            />
          </div>
        </>
      )}
    </Modal>
  );
}
/* ------------------------------------------------------------------
 * 落地页选择弹窗（对照「嘉力建站」：搜索 + 列表 + 单选确定）
 * ---------------------------------------------------------------- */
export function LpPickerModal(props: {
  open: boolean;
  onClose: () => void;
  pages: AssetItem[];
  loading?: boolean;
  value: string | null;
  onOk: (id: string | null) => void;
}) {
  const { open, onClose, pages, loading, value, onOk } = props;
  const [keyword, setKeyword] = useState('');
  const [picked, setPicked] = useState<string | null>(value);

  useEffect(() => {
    if (open) setPicked(value);
  }, [open, value]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return pages;
    return pages.filter((p) => p.name.toLowerCase().includes(kw) || p.id.includes(kw));
  }, [pages, keyword]);

  return (
    <Modal
      title="选择落地页"
      open={open}
      onCancel={onClose}
      width={640}
      onOk={() => onOk(picked)}
      okText="确定"
      okButtonProps={{ disabled: !picked }}
    >
      <Input
        allowClear
        prefix={<SearchOutlined style={{ color: '#B8B5AC' }} />}
        placeholder="搜索落地页名称或 ID"
        style={{ marginBottom: 12 }}
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
      />
      {loading ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      ) : filtered.length === 0 ? (
        <Empty
          description={pages.length === 0 ? '账户里没有建站落地页，可先去磁力建站创建后同步' : '没有匹配结果'}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          style={{ padding: 24 }}
        />
      ) : (
        <Radio.Group
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          style={{ width: '100%', maxHeight: 380, overflowY: 'auto' }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filtered.map((p) => (
              <Radio key={p.id} value={p.id} style={{ marginInlineEnd: 0 }}>
                <span style={{ fontSize: 13 }}>{p.name || p.id}</span>
                <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                  {p.id}
                </Typography.Text>
              </Radio>
            ))}
          </div>
        </Radio.Group>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------
 * 投放时段选择：行 = 周一至周日，列 = 0-23 点，按小时按下拖动选择
 * （对应平台 schedule_time 的 168 位 0/1 串，周一零点起）
 * ---------------------------------------------------------------- */

const DAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

export function TimeSeriesPicker(props: {
  value: boolean[];
  onChange: (next: boolean[]) => void;
}) {
  const { value, onChange } = props;
  /** 拖动模式：按下时决定本次拖动是「涂上」还是「擦掉」 */
  const painting = useRef<boolean | null>(null);

  useEffect(() => {
    const up = () => {
      painting.current = null;
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const setCell = (idx: number, on: boolean) => {
    if (value[idx] === on) return;
    const next = value.slice();
    next[idx] = on;
    onChange(next);
  };

  return (
    <div style={{ userSelect: 'none' }} onMouseLeave={() => (painting.current = null)}>
      <div style={{ display: 'flex', marginBottom: 2 }}>
        <div style={{ width: 32 }} />
        {Array.from({ length: 24 }, (_, h) => (
          <div
            key={h}
            style={{ width: 20, fontSize: 9, color: '#B8B5AC', textAlign: 'center' }}
          >
            {h}
          </div>
        ))}
      </div>
      {DAY_LABELS.map((d, day) => (
        <div key={d} style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ width: 32, fontSize: 11, color: '#888780' }}>周{d}</div>
          {Array.from({ length: 24 }, (_, h) => {
            const idx = day * 24 + h;
            const on = value[idx];
            return (
              <div
                key={h}
                onMouseDown={(e) => {
                  e.preventDefault();
                  painting.current = !on;
                  setCell(idx, !on);
                }}
                onMouseEnter={() => {
                  if (painting.current !== null) setCell(idx, painting.current);
                }}
                style={{
                  width: 20,
                  height: 18,
                  background: on ? BRAND : '#F5F4F0',
                  border: '1px solid #fff',
                  boxSizing: 'border-box',
                  cursor: 'pointer',
                }}
              />
            );
          })}
        </div>
      ))}
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        按住鼠标拖动即可批量选择 / 取消时段
      </Typography.Text>
    </div>
  );
}
