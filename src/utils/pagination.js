function getPagination(
  req,
  defaults = { page: 1, pageSize: 20, maxPageSize: 100 }
) {
  const page = Math.max(1, Number(req.query.page || defaults.page));

  const rawSize =
    req.query.pageSize ??
    req.query.pagesize ?? // alias
    defaults.pageSize;

  const pageSize = Math.min(
    defaults.maxPageSize,
    Math.max(1, Number(rawSize))
  );

  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset, limit: pageSize };
}

function buildPageInfo(total, page, pageSize) {
  const t = Number(total || 0);
  const p = Number(page || 1);
  const s = Number(pageSize || 20);
  const totalPages = Math.max(1, Math.ceil(t / Math.max(1, s)));

  return {
    total: t,
    page: p,
    pageSize: s,
    totalPages,
    hasNext: p < totalPages,
    hasPrev: p > 1,
  };
}

module.exports = { getPagination, buildPageInfo };