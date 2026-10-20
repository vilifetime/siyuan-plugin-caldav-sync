"""在本机启动 Radicale 的包装器（供 e2e / 附件探针使用）。

为什么需要：这台 Windows 机器**有** SeCreateSymbolicLinkPrivilege（ elevated / 开发者模式），
于是 radicale.pathutils.path_supports_symlink() 里的 os.symlink() 会成功，
紧接着的 os.remove() 作用在「指向目录的符号链接」上必然抛 WinError 5，
Radicale 启动即 CRITICAL 退出。普通 Windows 用户没有该权限、走 PermissionError 分支，
所以官方代码在别人机器上没问题 —— 这是本机特有的环境差异，不是 Radicale 的 bug。

处理：把探测短路成「不支持符号链接」。Radicale 只是用它决定能否用链接做原子替换，
返回 False 会退化成非原子写入，功能不受影响。

用法：python scripts/radicale-win.py --config <config>
"""
import sys

from radicale import pathutils

pathutils.path_supports_symlink = lambda path: False

from radicale import __main__

if __name__ == "__main__":
    __main__.run()
