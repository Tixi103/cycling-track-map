#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""make-release.py —— 打包一份可以直接发给别人的压缩包

只收运行时真正需要的文件，把下面这些排除掉：

  dev/                开发与测试工具，朋友用不上
  华为导出骑行文件/    你自己的骑行记录，属于私人数据
  _apptest.html 等     测试产物
  提示词.md           项目需求文档

用法：
    python dev/make-release.py [输出目录]

为什么不直接用「右键 → 压缩文件夹」？
    中文文件名在 zip 里有两种存法：按本地代码页，或者按 UTF-8 并置上
    通用位标记 bit 11。Windows 自带的压缩和 PowerShell 的 Compress-Archive
    走的是前者（字节其实是 UTF-8，但没置标记位），遇到严格的解压工具
    或非中文系统就会变成乱码。Python 的 zipfile 会正确置位。
    运行时文件全是 ASCII 名，只有文档和那个 .bat 是中文名 ——
    乱码了虽然不影响程序运行，但会让人以为文件坏了。
"""

import os
import sys
import zipfile
import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 收进包里的东西
FILES = ['index.html', '使用说明.md', '启动本地服务器.bat']
DIRS = ['css', 'js', 'lib']

# 这些名字不进包（大小写不敏感）
SKIP_NAMES = {'.ds_store', 'thumbs.db', 'desktop.ini', '.git'}

ZIP_ROOT = '骑行轨迹地图'

README = """骑行轨迹地图 —— 快速上手
================================

一、怎么打开
    双击 index.html 就行（推荐用 Chrome 或 Edge 浏览器）。
    不需要安装任何东西，也不需要联网登录。

二、怎么用
    1. 在手机上打开「华为运动健康」，进入「运动记录」
    2. 点开一条骑行记录 → 轨迹 → 右上角菜单 → 导出路线文件
    3. 选 GPX 格式，把文件传到电脑上
    4. 把文件拖进网页左上角的虚线框里

    支持 .gpx / .tcx / .kml 三种格式，可以一次拖很多个。

三、关于你的数据
    轨迹保存在**你自己电脑的浏览器里**，不会上传到任何地方。
    也就是说：换电脑、换浏览器就看不到了，除非用「导出备份」搬过去。
    骑了新的路线之后，建议顺手点一下右上角的「导出备份」。

四、遇到问题
    详细的说明在同目录下的「使用说明.md」里，用记事本或
    VS Code 打开就能看（md 是纯文本格式）。

    「启动本地服务器.bat」是个可选工具，一般情况下用不到。
    只有当你用的浏览器限制本地文件的存储能力时，才需要它。
    注意：这个脚本需要电脑上装了 Python 才能跑。

    ⚠ 如果 Windows 提示「这个文件来自网络」，那是系统的安全提示，
      这个项目完全离线运行、不联网（地图瓦片除外），可以放心。
"""


def should_skip(name):
    return name.lower() in SKIP_NAMES or name.startswith('.')


def collect(zf, dirpath, arcbase):
    """递归收目录，返回收进去的文件数"""
    count = 0
    for entry in sorted(os.listdir(dirpath)):
        if should_skip(entry):
            continue
        full = os.path.join(dirpath, entry)
        arc = arcbase + '/' + entry
        if os.path.isdir(full):
            count += collect(zf, full, arc)
        else:
            zf.write(full, arc)
            count += 1
    return count


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else ROOT
    stamp = datetime.datetime.now().strftime('%Y%m%d')
    outpath = os.path.join(outdir, '骑行轨迹地图-' + stamp + '.zip')

    total = 0
    with zipfile.ZipFile(outpath, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        # 先放一个给朋友的简短说明
        zf.writestr(ZIP_ROOT + '/快速上手.txt', README)
        total += 1

        for name in FILES:
            p = os.path.join(ROOT, name)
            if os.path.exists(p):
                zf.write(p, ZIP_ROOT + '/' + name)
                total += 1
            else:
                print('  警告：找不到 ' + name)

        for name in DIRS:
            p = os.path.join(ROOT, name)
            if os.path.isdir(p):
                total += collect(zf, p, ZIP_ROOT + '/' + name)
            else:
                print('  警告：找不到目录 ' + name)

    size = os.path.getsize(outpath)

    print('打包完成：' + outpath)
    print('  文件数：%d' % total)
    print('  体积：%.1f KB' % (size / 1024.0))
    print('')

    # 检查中文文件名是否带上了 UTF-8 标志位
    bad = []
    with zipfile.ZipFile(outpath) as zf:
        for info in zf.infolist():
            if any(ord(c) > 127 for c in info.filename):
                if not (info.flag_bits & 0x800):
                    bad.append(info.filename)

    if bad:
        print('  注意：以下中文文件名的条目没有置 UTF-8 标志位，')
        print('        个别解压工具可能显示成乱码（不影响程序运行）：')
        for b in bad:
            print('          ' + b)
    else:
        print('  中文文件名的编码标记正常。')

    print('')
    print('包里的内容：')
    with zipfile.ZipFile(outpath) as zf:
        for info in zf.infolist():
            print('    %-46s %8.1f KB' % (info.filename, info.file_size / 1024.0))


if __name__ == '__main__':
    main()
