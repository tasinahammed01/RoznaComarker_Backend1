'use strict';
const { parseCliArgs, sameOptions } = require('../scripts/migratePromoBilling');
test('promo migration defaults read-only and requires backup acknowledgement', () => {
  expect(parseCliArgs()).toEqual({apply:false,backupConfirmed:false});
  expect(()=>parseCliArgs(['--apply'])).toThrow('BACKUP');
  expect(parseCliArgs(['--apply','--backup-confirmed']).apply).toBe(true);
});
test.each([['--delete'],['--apply','--apply'],['--backup-confirmed','--unknown']])('rejects unsafe CLI arguments %j',(...args)=>expect(()=>parseCliArgs(args)).toThrow());
test('preserves equivalent indexes and rejects conflicting options',()=>{
  expect(sameOptions({name:'existing',unique:true},{unique:true})).toBe(true);
  expect(sameOptions({unique:true},{})).toBe(false);
  expect(sameOptions({expireAfterSeconds:0},{expireAfterSeconds:600})).toBe(false);
});
