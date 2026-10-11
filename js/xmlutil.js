/*!
 * xmlutil.js —— 命名空间无关的 XML 读取工具
 *
 * 为什么需要这个文件？
 *   各家 APP 导出的轨迹文件会使用不同的 XML 命名空间前缀，例如：
 *     华为 GPX:   <ns3:hr>            （ns3 = Garmin TrackPointExtension）
 *     华为 TCX:   <ns3:Speed>         （ns3 前缀随机变化）
 *     Garmin TCX: <ns3:TPX><ns3:Speed>
 *   getElementsByTagName('ns3:hr') 这种写法一旦前缀变化就会失效。
 *   因此本文件统一采用「忽略前缀，只匹配本地名（localName）」的方式查找节点，
 *   保证任意厂商、任意版本导出的文件都能正确解析。
 */
(function (global) {
  'use strict';

  /** 取出节点的本地名（去掉命名空间前缀）。旧浏览器无 localName 时退化为截取 nodeName。 */
  function localName(node) {
    if (node.localName) return node.localName;
    var name = node.nodeName || '';
    var idx = name.indexOf(':');
    return idx >= 0 ? name.slice(idx + 1) : name;
  }

  /** 判断节点是否为元素节点，且本地名等于 name */
  function isElem(node, name) {
    return node && node.nodeType === 1 && localName(node) === name;
  }

  /**
   * 在指定父节点下查找第一个匹配的元素（深度优先，忽略命名空间前缀）。
   * @param {Element} root 父节点
   * @param {string} name 目标本地名，如 'trkpt'
   * @returns {Element|null}
   */
  function first(root, name) {
    if (!root) return null;
    var children = root.childNodes;
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c.nodeType !== 1) continue;
      if (localName(c) === name) return c;
      var found = first(c, name);
      if (found) return found;
    }
    return null;
  }

  /**
   * 在指定父节点下查找所有匹配的元素（深度优先，忽略命名空间前缀）。
   * @param {Element} root 父节点
   * @param {string} name 目标本地名，如 'trkpt'
   * @returns {Element[]}
   */
  function all(root, name) {
    var out = [];
    if (!root) return out;
    (function walk(node) {
      var children = node.childNodes;
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c.nodeType !== 1) continue;
        if (localName(c) === name) out.push(c);
        walk(c);
      }
    })(root);
    return out;
  }

  /**
   * 只查找**直接子元素**中匹配的节点（不递归）。
   * 用于区分 <Trackpoint><Time> 和 <Activity><Lap><TotalTimeSeconds> 这类同名不同层级的情况。
   */
  function child(root, name) {
    if (!root) return null;
    var children = root.childNodes;
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c.nodeType === 1 && localName(c) === name) return c;
    }
    return null;
  }

  /** 查找所有直接子元素中匹配的节点（不递归）。 */
  function children(root, name) {
    var out = [];
    if (!root) return out;
    var list = root.childNodes;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.nodeType === 1 && localName(c) === name) out.push(c);
    }
    return out;
  }

  /** 去掉首尾空白的 textContent；节点不存在时返回 null。 */
  function text(node) {
    if (!node) return null;
    var t = node.textContent;
    if (t === null || t === undefined) return null;
    t = String(t).replace(/^\s+|\s+$/g, '');
    return t === '' ? null : t;
  }

  /** 读取 root 下第一个 name 节点的文本内容 */
  function textOf(root, name) {
    return text(first(root, name));
  }

  /** 安全解析浮点数，非法值返回 null */
  function num(node) {
    var t = text(node);
    if (t === null) return null;
    var v = parseFloat(t);
    return isFinite(v) ? v : null;
  }

  /** 读取 root 下第一个 name 节点的数值 */
  function numOf(root, name) {
    return num(first(root, name));
  }

  /**
   * 解析时间字符串为 UTC 毫秒时间戳。
   * 兼容 ISO 8601（含毫秒与 Z 后缀）以及 KML/gx:Track 中的常见写法。
   * @returns {number|null}
   */
  function parseTime(str) {
    if (!str) return null;
    var t = Date.parse(str);
    return isFinite(t) ? t : null;
  }

  /**
   * 从 XML 字符串解析为 DOM 文档，并校验是否有解析错误。
   * @param {string} xmlText
   * @returns {{doc: Document|null, error: string|null}}
   */
  function parseXml(xmlText) {
    // 去除 UTF-8 BOM，部分编辑器保存的文件带 BOM 会导致 DOMParser 报错。
    // 变量名刻意不叫 text —— 本文件另有一个同名的 text() 工具函数，
    // 函数作用域内的 var 声明会提升并遮蔽它，导致下面取错误信息时调用到一个字符串。
    var src = String(xmlText).replace(/^﻿/, '');

    var doc = null;
    try {
      if (typeof DOMParser !== 'undefined') {
        doc = new DOMParser().parseFromString(src, 'text/xml');
      } else if (typeof global.DOMParser !== 'undefined') {
        doc = new global.DOMParser().parseFromString(src, 'text/xml');
      }
    } catch (e) {
      // 个别环境在极端输入下 parseFromString 本身会抛异常，兜住它，
      // 保证本函数「只返回结果、永不抛错」这个契约成立。
      return { doc: null, error: 'XML 解析器异常：' + (e && e.message ? e.message : String(e)) };
    }

    if (!doc) return { doc: null, error: '当前环境不支持 XML 解析（DOMParser 不可用）' };

    // 浏览器解析 XML 失败时会返回包含 parsererror 元素的文档
    var errNode = doc.getElementsByTagName('parsererror')[0];
    if (!errNode) {
      // 某些浏览器把 parsererror 放在其他命名空间下
      var allNodes = doc.getElementsByTagName('*');
      for (var i = 0; i < allNodes.length; i++) {
        var ln = localName(allNodes[i]);
        if (ln === 'parsererror') { errNode = allNodes[i]; break; }
      }
    }
    if (errNode) {
      var msg = text(errNode) || '未知的 XML 语法错误';
      return { doc: null, error: '文件不是合法的 XML：' + msg };
    }

    return { doc: doc, error: null };
  }

  /** 取出根元素的本地名，如 'gpx' / 'TrainingCenterDatabase' / 'kml' */
  function rootName(doc) {
    if (!doc) return null;
    var root = doc.documentElement;
    return root ? localName(root) : null;
  }

  /** 读取元素上的属性值（属性名不区分命名空间） */
  function attr(node, name) {
    if (!node || !node.getAttribute) return null;
    var v = node.getAttribute(name);
    if (v !== null && v !== undefined) return v;
    // 退化处理：属性可能带前缀
    if (node.attributes) {
      for (var i = 0; i < node.attributes.length; i++) {
        var a = node.attributes[i];
        if (localName(a) === name) return a.value;
      }
    }
    return null;
  }

  global.XmlUtil = {
    localName: localName,
    isElem: isElem,
    first: first,
    all: all,
    child: child,
    children: children,
    text: text,
    textOf: textOf,
    num: num,
    numOf: numOf,
    parseTime: parseTime,
    parseXml: parseXml,
    rootName: rootName,
    attr: attr
  };
})(window);
