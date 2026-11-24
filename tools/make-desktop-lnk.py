# -*- coding: utf-8 -*-
"""
在桌面生成「快手投放工作台」快捷方式（真正的 .lnk）：
双击 = 启动服务（服务已在跑则直接复用）+ 自动打开网页。

为什么不用 Node 手写 .lnk：
  .lnk 的 LinkTargetIDList（MyComputer → C:\\ → Windows → System32 → cmd.exe）
  是逐级的二进制文件系统项，手写极易出错且报「没有应用程序与此操作关联」；
  WScript.Shell COM / Add-Type 在这台机器被安全策略禁用。
  所以用 pylnk3（纯 Python，无 COM）生成，结构可靠。

依赖：python -m pip install pylnk3

用法：python tools/make-desktop-lnk.py
"""
import os
import sys

try:
    import pylnk3
except ImportError:
    print("缺少依赖 pylnk3，请先执行：python -m pip install pylnk3")
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESKTOP = os.path.join(os.path.expanduser("~"), "Desktop")
LNK = os.path.join(DESKTOP, "快手投放工作台.lnk")
LEGACY_URL = os.path.join(DESKTOP, "快手投放工作台.url")

TARGET = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "cmd.exe")
STARTER = os.path.join(ROOT, "启动网页版.cmd")
ICON = os.path.join(ROOT, "tools", "icon.ico")

# /c "...启动网页版.cmd"：路径含中文但无空格，单层引号即可
ARGS = '/c "{}"'.format(STARTER)

lnk = pylnk3.for_file(
    TARGET,
    lnk_name=os.path.basename(LNK),
    arguments=ARGS,
    description="Kuaishou Workbench Web (start service + open browser)",
    icon_file=ICON,
    icon_index=0,
    work_dir=ROOT,
    window_mode="Minimized",  # 启动脚本的 cmd 窗口最小化，转后台后自动消失
)
lnk.save(LNK)

# 旧的 .url 只是纯网址书签（服务没起就打不开），改名留档避免桌面上两个同名图标
if os.path.exists(LEGACY_URL):
    bak = LEGACY_URL + ".bak"
    os.replace(LEGACY_URL, bak)
    print("旧 .url 已留档：{}".format(bak))

print("已生成：{}（{} 字节）".format(LNK, os.path.getsize(LNK)))
print("目标：{}".format(TARGET))
print("参数：{}".format(ARGS))
print("工作目录：{}".format(ROOT))
print("图标：{}".format(ICON))
