
function uuid() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// 定义一个函数去除字符串两端的引号
function trimQuotation(str) {
  return str.replace(/^"|"$/g, '');
}

function ensureArray(arr) {
  return Array.isArray(arr) ? arr : [arr];
}

module.exports = {
  uuid,
  trimQuotation,
  ensureArray,
}
