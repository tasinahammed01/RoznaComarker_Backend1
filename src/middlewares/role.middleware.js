function requireRole(roles) {
  const allowedRoles = Array.isArray(roles) ? roles : [roles];

  return function roleMiddleware(req, res, next) {
    const role = req && req.user && req.user.role;

    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden'
      });
    }

    return next();
  };
}

module.exports = {
  requireRole
};
