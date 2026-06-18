'use strict';

import Homey from 'homey';
import FireBoardClient from '../../lib/FireBoardClient';
import Logger from '../../lib/Logger';

module.exports = class FireBoardDevice extends Homey.Device {
  private readonly client = new FireBoardClient();
  private pollInterval?: NodeJS.Timeout;
  private probeLabels: Record<number, string> = {};
  private probeConnectionState: Record<number, boolean | undefined> = {};

  async onInit(): Promise<void> {
    Logger.device('FireBoard device initialized');

    await this.poll();
    this.startPolling();
  }

  private startPolling(): void {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
    }

    const intervalSeconds = this.getPollIntervalSeconds();

    Logger.device(`Starting FireBoard polling every ${intervalSeconds} seconds`);

    this.pollInterval = this.homey.setInterval(() => {
      this.poll().catch(error => this.error(error));
    }, intervalSeconds * 1000);
  }

  private getPollIntervalSeconds(): number {
    const setting = Number(this.getSetting('poll_interval') || 60);

    if ([15, 30, 60, 120, 300].includes(setting)) {
      return setting;
    }

    return 60;
  }

  async poll(): Promise<void> {
    try {
      await this.updateFromFireBoard();
      await this.setAvailable().catch(this.error);
    } catch (error) {
      Logger.error('FireBoard poll failed', error);

      await this.setUnavailable(
        'Unable to connect to FireBoard Cloud',
      ).catch(this.error);
    }
  }

  private async updateFromFireBoard(): Promise<void> {
    const token = this.getStoreValue('token');
    const device = this.getStoreValue('device');

    if (!token || !device?.uuid) {
      throw new Error('Missing FireBoard token or device UUID');
    }

    const latest = await this.client.getDevice(token, device.uuid);

    Logger.api('FireBoard API Status', {
      active: latest.active,
      last_templog: latest.last_templog,
      last_drivelog: latest.last_drivelog,
      latest_temps: latest.latest_temps,
      device_log: {
        date: latest.device_log?.date,
        boardID: latest.device_log?.boardID,
        mode: latest.device_log?.mode,
        ssid: latest.device_log?.ssid,
        internalIP: latest.device_log?.internalIP,
        signallevel: latest.device_log?.signallevel,
        linkquality: latest.device_log?.linkquality,
        uptime: latest.device_log?.uptime,
        vBatt: latest.device_log?.vBatt,
        vBattPer: latest.device_log?.vBattPer,
        onboardTemp: latest.device_log?.onboardTemp,
      },
      channels: latest.channels?.map((channel: any) => ({
        channel: channel.channel,
        label: channel.channel_label,
        current_temp: channel.current_temp,
        last_templog: channel.last_templog,
        state: channel.state,
        enabled: channel.enabled,
        sessionid: channel.sessionid,
      })),
    });

    await this.updateInfoSettings(latest);
	await this.updateBattery(latest);

	if (this.isFireBoardStale(latest)) {
	  Logger.device('FireBoard data is stale, marking device unavailable');

	  await this.clearLiveValues();

	  await this.setUnavailable(
      'FireBoard appears to be offline',
	  ).catch(this.error);

	  return;
	}

	await this.updateInternalTemperature(latest);
	await this.updateFanOutput(latest);
	await this.updateProbes(latest);
  }
  private isFireBoardStale(latest: any): boolean {
     const timestamp = this.getLatestFireBoardTimestamp(latest);

     if (!timestamp) {
       return true;
     }

     const ageMs = Date.now() - timestamp.getTime();
     const maxAgeMs = this.getPollIntervalSeconds() * 3 * 1000;

     return ageMs > maxAgeMs;
  }

  private getLatestFireBoardTimestamp(latest: any): Date | null {
     const candidates = [
      latest.last_templog,
      latest.device_log?.date,
      latest.last_drivelog?.created,
     ];

     for (const candidate of candidates) {
     const parsed = this.parseFireBoardDate(candidate);

       if (parsed) {
         return parsed;
       }
     }

     return null;
  }

  private parseFireBoardDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  const normalized = value.endsWith(' UTC')
    ? value.replace(' UTC', 'Z').replace(' ', 'T')
    : value;

  const date = new Date(normalized);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

private async clearLiveValues(): Promise<void> {
  await this.setCapabilityValue('measure_temperature', null).catch(this.error);

  if (this.hasCapability('measure_fan_output')) {
    await this.setCapabilityValue('measure_fan_output', null).catch(this.error);
  }

  for (let probe = 1; probe <= 6; probe++) {
    const capability = `measure_temperature_probe${probe}`;

    if (this.hasCapability(capability)) {
      await this.setCapabilityValue(capability, null).catch(this.error);
    }
  }
}
  private async updateInfoSettings(latest: any): Promise<void> {
    const deviceLog = latest.device_log || {};

    const settings = {
      info_model: String(latest.model_name || latest.model || '-'),
      info_firmware: String(latest.version || deviceLog.version || '-'),
      info_hardware_id: String(latest.hardware_id || deviceLog.boardID || '-'),
      info_last_update: String(deviceLog.date || new Date().toISOString()),
      info_ssid: String(deviceLog.ssid || '-'),
      info_wifi_signal: deviceLog.signallevel !== undefined
        ? `${deviceLog.signallevel} dBm`
        : '-',
      info_drive: latest.last_drivelog
        ? 'Available'
        : 'Not detected',
    };

    await this.setSettings(settings).catch(this.error);
  }

  private async updateBattery(latest: any): Promise<void> {
    const battery = latest.last_battery_reading ?? latest.device_log?.vBattPer;

    if (typeof battery === 'number') {
      await this.setCapabilityValue(
        'measure_battery',
        Math.round(battery * 100),
      ).catch(this.error);
    }
  }

  private async updateInternalTemperature(latest: any): Promise<void> {
    const onboardTemp = latest.device_log?.onboardTemp;

    if (typeof onboardTemp === 'number') {
      await this.setCapabilityValue(
        'measure_temperature',
        onboardTemp,
      ).catch(this.error);
    }
  }

  private async updateFanOutput(latest: any): Promise<void> {
    const fanOutput = this.getFanOutput(latest);

    if (!this.hasCapability('measure_fan_output')) {
      return;
    }

    if (typeof fanOutput === 'number') {
      await this.setCapabilityValue(
        'measure_fan_output',
        Math.round(fanOutput),
      ).catch(this.error);
    } else {
      await this.setCapabilityValue(
        'measure_fan_output',
        null,
      ).catch(this.error);
    }
  }

  private getFanOutput(latest: any): number | null {
    const driveLog = latest.last_drivelog;

    if (!driveLog || typeof driveLog !== 'object') {
      return null;
    }

    const candidates = [
      driveLog.fan,
      driveLog.fan_output,
      driveLog.fanOutput,
      driveLog.output,
      driveLog.drive_output,
      driveLog.driveOutput,
      driveLog.percent,
      driveLog.percentage,
      driveLog.duty,
      driveLog.duty_cycle,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'number') {
        return candidate;
      }
    }

    Logger.object('Unknown Drive Log Format', driveLog);

    return null;
  }

  private async updateProbes(latest: any): Promise<void> {
    const channels = latest.channels || [];

    const activeProbes = new Set<number>(
      channels
        .filter((channel: any) => typeof channel.current_temp === 'number')
        .map((channel: any) => channel.channel),
    );

    for (let probe = 1; probe <= 6; probe++) {
      const isConnected = activeProbes.has(probe);

      await this.handleProbeConnectionChange(probe, isConnected);

      const capability = `measure_temperature_probe${probe}`;

      if (!isConnected && this.hasCapability(capability)) {
        await this.setCapabilityValue(
          capability,
          null,
        ).catch(this.error);
      }
    }

    for (const channel of channels) {
      const probeNumber = channel.channel;
      const temperature = channel.current_temp;

      if (
        typeof probeNumber !== 'number'
        || typeof temperature !== 'number'
      ) {
        continue;
      }

      const capability = `measure_temperature_probe${probeNumber}`;

      if (!this.hasCapability(capability)) {
        continue;
      }

      const label = this.getProbeLabel(channel);

      await this.updateProbeLabel(probeNumber, capability, label);

      await this.setCapabilityValue(
        capability,
        temperature,
      ).catch(this.error);
    }

    Logger.device(
      channels
        .filter((channel: any) => channel.current_temp !== undefined)
        .map((channel: any) => `P${channel.channel}=${channel.current_temp}`)
        .join(', '),
    );
  }

  private getProbeLabel(channel: any): string {
    const probeNumber = channel.channel;

    const rawLabel = typeof channel.channel_label === 'string'
      ? channel.channel_label
      : '';

    if (rawLabel === `Channel ${probeNumber}`) {
      return `Probe ${probeNumber}`;
    }

    return rawLabel || `Probe ${probeNumber}`;
  }

  private async updateProbeLabel(
    probeNumber: number,
    capability: string,
    label: string,
  ): Promise<void> {
    if (this.probeLabels[probeNumber] === label) {
      return;
    }

    this.probeLabels[probeNumber] = label;

    await this.setStoreValue(
      `probe${probeNumber}_label`,
      label,
    ).catch(this.error);

    await this.setCapabilityOptions(capability, {
      title: {
        en: label,
        nl: label,
      },
    }).catch(this.error);

    Logger.device(`Updated probe label ${probeNumber}: ${label}`);
  }

  private async handleProbeConnectionChange(
    probeNumber: number,
    isConnected: boolean,
  ): Promise<void> {
    const previous = this.probeConnectionState[probeNumber];

    this.probeConnectionState[probeNumber] = isConnected;

    if (previous === undefined || previous === isConnected) {
      return;
    }

    const label = this.getStoreValue(`probe${probeNumber}_label`)
      || `Probe ${probeNumber}`;

    const cardId = isConnected
      ? 'probe_connected'
      : 'probe_disconnected';

    Logger.device(
      `${label} ${isConnected ? 'connected' : 'disconnected'}`,
    );

    await this.homey.flow
      .getDeviceTriggerCard(cardId)
      .trigger(this, {
        probe: String(label),
        probe_number: probeNumber,
      })
      .catch(this.error);
  }

  async onSettings({
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    if (changedKeys.includes('poll_interval')) {
      this.startPolling();

      return 'Poll interval updated';
    }

    return undefined;
  }

  async onDeleted(): Promise<void> {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
    }

    Logger.device('FireBoard device deleted');
  }
};