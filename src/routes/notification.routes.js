const express = require('express');

const notificationController = require('../controllers/notification.controller');
const { verifyJwtToken } = require('../middlewares/jwtAuth.middleware');

const router = express.Router();

router.get('/unread-count', verifyJwtToken, notificationController.getUnreadCount);
router.get('/', verifyJwtToken, notificationController.listMyNotifications);
router.patch('/:id/read', verifyJwtToken, notificationController.markRead);
router.patch('/read-all', verifyJwtToken, notificationController.markAllRead);

// SSE stream (EventSource cannot send Authorization header in most browsers)
router.get('/stream', notificationController.streamMyNotifications);

module.exports = router;
