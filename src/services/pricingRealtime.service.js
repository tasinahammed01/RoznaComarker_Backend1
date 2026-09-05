'use strict';
const logger=require('../utils/logger');const {publishSystemEvent}=require('./notificationRealtime.service');
function publishPricingConfigUpdated({entity,key}){const payload={entity,key,changedAt:new Date().toISOString()};try{publishSystemEvent({event:'pricing_config_updated',payload});return payload}catch(error){logger.warn({event:'pricing_config_updated_publish_failed',entity,key,message:error?.message});return null}}
module.exports={publishPricingConfigUpdated};
