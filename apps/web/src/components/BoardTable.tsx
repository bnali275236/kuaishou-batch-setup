import {
  ColumnWidthOutlined,
  DownloadOutlined,
  HolderOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { Button, Checkbox, Empty, Popover, Space, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ------------------------------------------------------------------
 * 看板通用表格增强（盯盘 / 素材 等所有看板共用）：
 *   1. 下载报表（xlsx，只导出当前可见列，按当前列顺序）
 *   2. 重置列宽（列头右侧可拖拽调宽）
 *   3. 自定义列（勾选显隐 + 拖拽排序），配置按页面持久化到 localStorage
 * ------------------------------------------------------------------ */

interface ColumnConfig {
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
}

function readConfig(storageKey: string): ColumnConfig | null {
  try {
    const raw = localStorage.getItem(`wkbd_board_${storageKey}`);
    return raw ? (JSON.parse(raw) as ColumnConfig) : null;
  } catch {
    return null;
  }
}

function writeConfig(storageKey: string, cfg: ColumnConfig): void {
  try {
    localStorage.setItem(`wkbd_board_${storageKey}`, JSON.stringify(cfg));
  } catch {
    /* 存储满了就算了，配置不是关键数据 */
  }
}

/** 列的唯一标识：优先 key，其次 dataIndex */
export function colKeyOf<T>(col: ColumnsType<T>[number], index: number): string {
  const c = col as { key?: unknown; dataIndex?: unknown };
  if (c.key != null) return String(c.key);
  const di = c.dataIndex;
  if (typeof di === 'string' || typeof di === 'number') return String(di);
  if (Array.isArray(di)) return di.join('.');
  return `__col_${index}`;
}

/** 从 ReactNode 标题里抽纯文本（导出表头用） */
function titleToText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(titleToText).join('');
  if (typeof node === 'object') {
    const props = (node as { props?: { children?: unknown } }).props;
    if (props?.children !== undefined) return titleToText(props.children);
  }
  return '';
}

interface HeaderCellProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  width?: number;
  onResize?: (nextWidth: number) => void;
}

/** 可拖拽调宽的表头单元格（右侧 8px 热区） */
function ResizeHeaderCell({ width, onResize, children, ...rest }: HeaderCellProps) {
  const dragging = useRef<{ x: number; w: number } | null>(null);
  return (
    <th {...rest} style={{ position: 'relative', ...(rest.style ?? {}) }}>
      {children}
      {width != null && onResize && (
        <span
          className="col-resize-handle"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dragging.current = { x: e.clientX, w: width };
            const move = (ev: MouseEvent) => {
              if (!dragging.current) return;
              const next = Math.max(60, dragging.current.w + ev.clientX - dragging.current.x);
              onResize(next);
            };
            const up = () => {
              dragging.current = null;
              window.removeEventListener('mousemove', move);
              window.removeEventListener('mouseup', up);
              document.body.style.cursor = '';
              document.body.style.userSelect = '';
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
        />
      )}
    </th>
  );
}

export interface BoardTableApi<T> {
  /** 处理后的列（顺序 + 显隐 + 宽度） */
  columns: ColumnsType<T>;
  /** 传给 Table 的 components（表头可拖拽） */
  tableComponents: { header: { cell: typeof ResizeHeaderCell } };
  /** 右上角工具条（放到 Card extra / 页头右侧） */
  toolbar: React.ReactNode;
  /** 导出当前可见列 */
  exportRows: () => void;
}

export function useBoardTable<T>(opts: {
  /** localStorage 键名（页面级唯一） */
  storageKey: string;
  columns: ColumnsType<T>;
  /** 导出文件名（不带扩展名） */
  exportFileName: string;
  /** 导出用数据行（调用方给当前表格数据源） */
  exportRows: () => Array<Record<string, unknown>>;
  /** 可选：某些列导出时用别的取值（如「账户」列导出 accountName 而不是 dataIndex advertiserId） */
  exportValueOf?: Record<string, (row: Record<string, unknown>) => unknown>;
}): BoardTableApi<T> {
  const { storageKey, columns, exportFileName } = opts;

  /** 每列的默认宽度（number 或 undefined） */
  const defaultWidths = useMemo(() => {
    const m: Record<string, number> = {};
    columns.forEach((c, i) => {
      const w = (c as { width?: unknown }).width;
      if (typeof w === 'number') m[colKeyOf(c, i)] = w;
    });
    return m;
  }, [columns]);

  const [cfg, setCfg] = useState<ColumnConfig>(() => readConfig(storageKey) ?? { order: [], hidden: [], widths: {} });
  useEffect(() => {
    writeConfig(storageKey, cfg);
  }, [storageKey, cfg]);

  /** 全量列元信息（按当前声明顺序） */
  const metas = useMemo(
    () => columns.map((c, i) => ({ key: colKeyOf(c, i), col: c, title: titleToText((c as { title?: unknown }).title) })),
    [columns],
  );

  /** 有效顺序：已保存的顺序在前（仅限仍然存在的 key），新列按声明顺序补在后面 */
  const orderedMetas = useMemo(() => {
    const byKey = new Map(metas.map((m) => [m.key, m]));
    const saved = (cfg.order ?? []).map((k) => byKey.get(k)).filter(Boolean) as typeof metas;
    const rest = metas.filter((m) => !(cfg.order ?? []).includes(m.key));
    return [...saved, ...rest];
  }, [metas, cfg.order]);

  const hiddenSet = useMemo(() => new Set(cfg.hidden ?? []), [cfg.hidden]);

  const visibleMetas = orderedMetas.filter((m) => !hiddenSet.has(m.key));
  const hiddenMetas = orderedMetas.filter((m) => hiddenSet.has(m.key));

  const resolvedColumns: ColumnsType<T> = useMemo(
    () =>
      visibleMetas.map((m) => {
        const col = m.col as {
          width?: number;
          onHeaderCell?: unknown;
        };
        const width = cfg.widths?.[m.key] ?? defaultWidths[m.key];
        return {
          ...col,
          width,
          onHeaderCell: () => ({ width, onResize: (next: number) => setCfg((p) => ({ ...p, widths: { ...p.widths, [m.key]: next } })) }),
        } as ColumnsType<T>[number];
      }),
    [visibleMetas, cfg.widths, defaultWidths],
  );

  const resetWidths = useCallback(() => {
    setCfg((p) => ({ ...p, widths: {} }));
  }, []);

  const toggleVisible = (key: string, checked: boolean) => {
    setCfg((p) => {
      const hidden = new Set(p.hidden ?? []);
      if (checked) hidden.delete(key);
      else hidden.add(key);
      return { ...p, hidden: [...hidden] };
    });
  };

  /* —— 拖拽排序（HTML5 DnD）：拖动经过目标行时实时重排，松手即生效 —— */
  const dragKeyRef = useRef<string | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);

  const reorderTo = (from: string, to: string) => {
    if (!from || from === to) return;
    setCfg((p) => {
      const keys = orderedMetas.map((m) => m.key);
      const i = keys.indexOf(from);
      const j = keys.indexOf(to);
      if (i < 0 || j < 0) return p;
      const [moved] = keys.splice(i, 1);
      keys.splice(j, 0, moved);
      return { ...p, order: keys };
    });
  };

  const exportRows = useCallback(() => {
    const rows = opts.exportRows();
    if (rows.length === 0) return;
    const specs = visibleMetas.map((m) => ({
      title: m.title || m.key,
      get: (row: Record<string, unknown>) => {
        const custom = opts.exportValueOf?.[m.key];
        if (custom) return custom(row);
        const col = m.col as { dataIndex?: string | string[] };
        const di = col.dataIndex;
        if (typeof di === 'string') return row[di];
        if (Array.isArray(di)) return di.reduce<unknown>((acc, k) => (acc == null ? acc : (acc as Record<string, unknown>)[k]), row);
        return '';
      },
    }));
    void (async () => {
      try {
        const XLSX = await import('xlsx');
        const aoa: unknown[][] = [specs.map((s) => s.title)];
        for (const row of rows) aoa.push(specs.map((s) => s.get(row)));
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = specs.map((s) => ({ wch: Math.max(10, Math.min(44, s.title.length * 2 + 6)) }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '报表');
        XLSX.writeFile(wb, `${exportFileName}.xlsx`);
      } catch (err) {
        // 降级：CSV（带 BOM，Excel 可直接打开）
        const esc = (v: unknown) => {
          const s = v == null ? '' : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const csv =
          '\uFEFF' +
          [specs.map((s) => esc(s.title)).join(','), ...rows.map((r) => specs.map((s) => esc(s.get(r))).join(','))].join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${exportFileName}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleMetas, opts.exportRows, opts.exportValueOf, exportFileName]);

  const columnConfigPanel = (
    <div style={{ maxHeight: 420, overflowY: 'auto', minWidth: 240 }}>
      {orderedMetas.length === 0 && <Empty description="无可配置列" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
      {orderedMetas.length > 1 && (
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
          按住 <HolderOutlined style={{ fontSize: 10 }} /> 上下拖动调整列顺序
        </Typography.Text>
      )}
      {orderedMetas.map((m) => (
        <div
          key={m.key}
          draggable
          onDragStart={(e) => {
            dragKeyRef.current = m.key;
            setDraggingKey(m.key);
            e.dataTransfer.effectAllowed = 'move';
            // 兼容 Firefox：必须 setData 才会触发拖拽
            e.dataTransfer.setData('text/plain', m.key);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (dragKeyRef.current) reorderTo(dragKeyRef.current, m.key);
          }}
          onDrop={(e) => e.preventDefault()}
          onDragEnd={() => {
            dragKeyRef.current = null;
            setDraggingKey(null);
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '3px 0',
            borderBottom: '1px dashed rgba(128,128,128,.15)',
            opacity: draggingKey === m.key ? 0.35 : 1,
            cursor: 'grab',
          }}
        >
          <HolderOutlined style={{ fontSize: 11, color: draggingKey === m.key ? '#534AB7' : '#B8B5AC', flex: 'none' }} />
          <Checkbox
            checked={!hiddenSet.has(m.key)}
            disabled={visibleMetas.length <= 1 && !hiddenSet.has(m.key)}
            onChange={(e) => toggleVisible(m.key, e.target.checked)}
          >
            <Typography.Text style={{ fontSize: 12 }}>{m.title || m.key}</Typography.Text>
          </Checkbox>
        </div>
      ))}
      {hiddenMetas.length > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
          已隐藏 {hiddenMetas.length} 列，勾选可恢复显示
        </Typography.Text>
      )}
    </div>
  );

  const toolbar = (
    <Space size={2}>
      <Tooltip title="下载报表（xlsx）">
        <Button size="small" type="text" icon={<DownloadOutlined />} onClick={exportRows} />
      </Tooltip>
      <Tooltip title="重置列宽">
        <Button size="small" type="text" icon={<ColumnWidthOutlined />} onClick={resetWidths} />
      </Tooltip>
      <Popover placement="bottomRight" trigger="click" content={columnConfigPanel} title="自定义列（显隐 / 拖拽排序）">
        <Tooltip title="自定义列">
          <Button size="small" type="text" icon={<SettingOutlined />} />
        </Tooltip>
      </Popover>
    </Space>
  );

  return {
    columns: resolvedColumns,
    tableComponents: { header: { cell: ResizeHeaderCell } },
    toolbar,
    exportRows,
  };
}
