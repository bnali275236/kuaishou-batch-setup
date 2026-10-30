import type { ReactNode } from 'react';

/**
 * 全局界面偏好（2026-09-29 简化）：
 * 皮肤（白天/黑夜）与语言（中文/English）栏目已按需求移除，
 * 界面固定为浅色 + 简体中文。保留 t() 字典函数供外壳取文案。
 */

/** 界面文案字典（外壳与公共区域；业务表单术语保持中文原文） */
const DICT = {
  appName: '快手广告工作台',
  dashboard: '盯盘看板',
  materials: '素材看板',
  plan: '上计划',
  tasks: '批量任务',
  accounts: '账户管理',
  settings: '设置',
} as const;

export type Dict = typeof DICT;

export interface UiContextValue {
  theme: 'light';
  lang: 'zh';
  setTheme: (t: 'light') => void;
  setLang: (l: 'zh') => void;
  t: (k: keyof Dict) => string;
}

export function UiPrefsProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useUiPrefs(): UiContextValue {
  return {
    theme: 'light',
    lang: 'zh',
    setTheme: () => undefined,
    setLang: () => undefined,
    t: (k) => DICT[k],
  };
}
