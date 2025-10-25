function getPagination(req, defaults = { page: 1, pageSize: 20, maxPageSize: 100 }) {
  const page = Math.max(1, Number(req.query.page || defaults.page));
  const pageSize = Math.min(defaults.maxPageSize, Math.max(1, Number(req.query.pageSize || defaults.pageSize)));
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset, limit: pageSize };
}

function buildPageInfo(total, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return { total, page, pageSize, totalPages, hasNext: page < totalPages, hasPrev: page > 1 };
}

module.exports = { getPagination, buildPageInfo };
