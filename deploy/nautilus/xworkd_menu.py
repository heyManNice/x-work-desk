#!/usr/bin/env python3
"""xworkd 文件传输 —— Nautilus 右键菜单扩展。

菜单项：
  右键文件      -> 下载文件
  右键文件夹    -> 上传文件到此目录
  多选文件      -> 下载 N 个文件
  多选含文件夹  -> 下载 N 个项目
  右键目录空白  -> 上传文件到当前目录

点击后通过 HTTP POST 通知 xworkd 服务端（127.0.0.1:XWORKD_PORT），
服务端校验 token（X-Workd-Token）后经 WebSocket 推送给浏览器执行真正的传输。

仅在 xworkd 远程拉起的会话（环境含 XWORKD_REMOTE=1）中显示菜单；
本地直接登录的会话不显示，不影响本地用户。

依赖：python3-nautilus（Ubuntu 24.04 包名，Nautilus 4.0 GI）。
"""
import os
import urllib.request
import gi

gi.require_version('Nautilus', '4.0')
from gi.repository import Nautilus, GObject  # noqa: E402

REMOTE = os.environ.get('XWORKD_REMOTE') == '1'
TOKEN = os.environ.get('XWORKD_TOKEN', '')
PORT = os.environ.get('XWORKD_PORT', '5268')
API = 'http://127.0.0.1:%s/api/transfer/request' % PORT


def notify(action: str, paths: list[str]) -> None:
    """POST 通知服务端。action: 'download' / 'uploaddir'。"""
    if not TOKEN or not paths:
        return
    body = (action + '\n' + '\n'.join(paths)).encode('utf-8')
    req = urllib.request.Request(
        API, data=body, method='POST',
        headers={'Content-Type': 'text/plain', 'X-Workd-Token': TOKEN})
    try:
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


def path_of(file_info) -> str | None:
    loc = file_info.get_location()  # GFile
    return loc.get_path() if loc else None


class XWorkdMenuProvider(GObject.GObject, Nautilus.MenuProvider):
    def get_file_items(self, files):
        """右键文件/文件夹。多选时合并为单个菜单项。"""
        if not REMOTE:
            return []
        items = []
        n = len(files)
        if n == 1:
            f = files[0]
            p = path_of(f)
            if f.is_directory():
                items.append(self._make_item('上传文件到此目录', 'uploaddir', [p]))
            else:
                items.append(self._make_item('下载文件', 'download', [p]))
        elif n > 1:
            paths = [path_of(f) for f in files]
            label = '下载 %d 个文件' % n if all(
                not f.is_directory() for f in files) else '下载 %d 个项目' % n
            items.append(self._make_item(label, 'download', paths))
        return items

    def get_background_items(self, current_folder):
        """右键目录空白处。"""
        if not REMOTE:
            return []
        p = path_of(current_folder)
        return [self._make_item('上传文件到当前目录', 'uploaddir', [p])]

    def _make_item(self, label, action, paths):
        item = Nautilus.MenuItem(name='XWorkdMenu::' + action, label=label)
        item.connect('activate', self._on_activate, action, paths)
        return item

    def _on_activate(self, menu, action, paths):
        notify(action, [p for p in paths if p])
