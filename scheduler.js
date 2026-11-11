'use strict';

const { ScannerSettings } = require('./models');
const scanner = require('./scanner');
const logger = require('./logger');

let timer = null;
let nextScanAt = null;

async function getSettings() {
  let settings = await ScannerSettings.findById('global').lean();
  if (settings) return settings;
  try { return (await ScannerSettings.create({ _id: 'global' })).toObject(); }
  catch (error) {
    if (error.code !== 11000) throw error;
    settings = await ScannerSettings.findById('global').lean();
    if (!settings) throw error;
    return settings;
  }
}

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
  nextScanAt = null;
}

function schedule(settings) {
  clearTimer();
  if (!settings.autoScanEnabled) {
    logger.info('automatic_scanning_disabled');
    return;
  }
  const intervalMinutes = settings.scanIntervalMinutes || 360;
  nextScanAt = new Date(Date.now() + intervalMinutes * 60 * 1000);
  logger.info('automatic_scan_scheduled', { intervalMinutes, nextScanAt: nextScanAt.toISOString() });
  timer = setTimeout(async () => {
    timer = null;
    const startedAt = new Date();
    logger.info('automatic_scan_started', { scheduledAt: nextScanAt?.toISOString() || null });
    try {
      await scanner.scanAll();
      logger.info('automatic_scan_finished', { durationMs: Date.now() - startedAt.getTime() });
    } catch (error) {
      logger.error('automatic_scan_failed', { message: error.message, stack: error.stack });
    }
    nextScanAt = null;
    try { schedule(await getSettings()); }
    catch (error) { logger.error('automatic_scan_reschedule_failed', { message: error.message }); }
  }, intervalMinutes * 60 * 1000);
  timer.unref?.();
}

async function startScheduler() {
  const settings = await getSettings();
  logger.info('automatic_scan_settings_loaded', { autoScanEnabled: settings.autoScanEnabled, intervalMinutes: settings.scanIntervalMinutes });
  schedule(settings);
}

async function updateSettings(updates) {
  await getSettings();
  const settings = await ScannerSettings.findByIdAndUpdate('global', { $set: updates }, { new: true, runValidators: true }).lean();
  schedule(settings);
  return settings;
}

function getNextScanAt() { return nextScanAt; }

module.exports = { startScheduler, getSettings, updateSettings, getNextScanAt };
