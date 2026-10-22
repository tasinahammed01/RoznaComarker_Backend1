'use strict';
// Test command safety: cached local Mongo only; no external sockets, HTTP or fetch.
const net=require('net');
const loopback=host=>['127.0.0.1','localhost','::1','[::1]'].includes(String(host));
const denied=()=>{throw Error('OFFLINE_TEST_EXTERNAL_NETWORK_DENIED');};
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){let a=args[0];if(Array.isArray(a))a=a[0];
  const host=a&&typeof a==='object'?a.host||'localhost':typeof args[1]==='string'?args[1]:'localhost';
  if(!loopback(host))return denied();return connect.apply(this,args);};
for(const name of ['http','https']){const mod=require(name);for(const method of ['get','request']){
  const fn=mod[method];mod[method]=function(...args){const a=args[0];const host=typeof a==='string'||a instanceof URL?new URL(a).hostname:a?.hostname||a?.host||'localhost';
    if(!loopback(host))return denied();return fn.apply(this,args);};}}
const original=global.fetch;global.fetch=(url,...args)=>{if(!loopback(new URL(url.url||url).hostname))return denied();return original(url,...args);};
process.env.MONGOMS_RUNTIME_DOWNLOAD='false';
