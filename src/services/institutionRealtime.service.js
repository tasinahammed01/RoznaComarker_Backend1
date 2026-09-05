'use strict';
const InstitutionMember = require('../models/InstitutionMember');
const { publishToUser } = require('./notificationRealtime.service');
const logger = require('../utils/logger');

async function publishInstitutionUpdated({ institutionId, reason, affectedUserIds = [] }) {
  try {
    const activeUserIds = await InstitutionMember.find({ institutionId, status: 'ACTIVE' }).distinct('userId');
    const recipients = [...new Set([...activeUserIds, ...affectedUserIds].filter(Boolean).map(String))];
    const payload = { institutionId: String(institutionId), reason };
    for (const userId of recipients) publishToUser({ userId, event: 'institution_updated', payload });
  } catch (error) {
    logger.warn({ message: 'Institution realtime invalidation failed', institutionId: String(institutionId), reason });
  }
}

module.exports = { publishInstitutionUpdated };
