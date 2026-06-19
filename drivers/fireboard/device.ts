'use strict';

import Homey from 'homey';
import FireBoardClient from '../../lib/FireBoardClient';
import Logger from '../../lib/Logger';

module.exports = class FireBoardDevice extends Homey.Device {
  private readonly client = new FireBoardClient();
  private pollInterval?: NodeJS.Timeout;
  private probeLabels: Record<number, string> = {};
  private probeConnectionState: Record<number, boolean | undefined> = {};
  private hasLoggedRawDeviceResponse = false;

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

    if ([30, 60, 120, 300].includes(setting)) {
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

    if (!this.hasLoggedRawDeviceResponse) {
      Logger.api('FireBoard RAW Device Response', latest);
      this.hasLoggedRawDeviceResponse = true;
    }

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
    const activeProbeCount = this.getActiveProbeCount(latest);
    const sessionId = this.getCurrentSessionId(latest);
    const isDriveModel = this.isDriveModel(latest);

    const settings = {
      info_title: this.formatText(latest.title),
      info_model: this.formatText(latest.model_name || latest.model),
      info_model_code: this.formatText(latest.model || deviceLog.model),
      info_hardware_id: this.formatText(latest.hardware_id || deviceLog.boardID),
      info_uuid: this.formatText(latest.uuid || deviceLog.deviceID),
      info_channel_count: this.formatText(latest.channel_count),

      info_firmware: this.formatText(latest.version || deviceLog.version),
      info_firmware_utils: this.formatText(latest.fbu_version || deviceLog.versionUtils),
      info_firmware_java: this.formatText(latest.fbj_version || deviceLog.versionJava),
      info_firmware_node: this.formatText(latest.fbn_version || deviceLog.versionNode),

      info_last_update: this.formatText(deviceLog.date),
      info_last_templog: this.formatText(latest.last_templog),
      info_active_probes: `${activeProbeCount} / ${latest.channel_count || 6}`,
      info_session_id: this.formatText(sessionId),
      info_auto_session: latest.auto_session === true ? 'Enabled' : 'Disabled',

      info_ssid: this.formatText(deviceLog.ssid),
      info_internal_ip: this.formatText(deviceLog.internalIP),
      info_public_ip: this.formatText(deviceLog.publicIP),
      info_wifi_signal: typeof deviceLog.signallevel === 'number'
        ? `${deviceLog.signallevel} dBm`
        : '-',
      info_link_quality: this.formatText(deviceLog.linkquality),
      info_wifi_frequency: this.formatText(deviceLog.frequency),
      info_wifi_band: this.formatText(deviceLog.band),

      info_battery_voltage: typeof deviceLog.vBatt === 'number'
        ? `${deviceLog.vBatt.toFixed(2)} V`
        : '-',
      info_battery_raw: typeof deviceLog.vBattPerRaw === 'number'
        ? `${Math.round(deviceLog.vBattPerRaw * 100)} %`
        : '-',

      info_uptime: this.formatText(deviceLog.uptime),
      info_cpu_usage: this.formatText(deviceLog.cpuUsage),
      info_memory_usage: this.formatText(deviceLog.memUsage),
      info_disk_usage: this.formatText(deviceLog.diskUsage),
      info_board_temperature: typeof deviceLog.onboardTemp === 'number'
        ? `${deviceLog.onboardTemp.toFixed(1)} °C`
        : '-',

      info_drive: this.getDriveStatus(latest, isDriveModel),
      info_drive_settings: this.getDriveSettingsSummary(deviceLog.drivesettings),
      info_drive_log: latest.last_drivelog
        ? 'Available'
        : 'No recent Drive activity',
    };

    await this.setSettings(settings).catch(this.error);
  }

  private getActiveProbeCount(latest: any): number {
    const channels = latest.channels || [];

    return channels.filter((channel: any) => (
      typeof channel.current_temp === 'number'
    )).length;
  }

  private getCurrentSessionId(latest: any): string | number | null {
    const channels = latest.channels || [];
    const activeChannel = channels.find((channel: any) => channel.sessionid);

    return activeChannel?.sessionid || null;
  }

  private isDriveModel(latest: any): boolean {
    const modelName = String(latest.model_name || '').toLowerCase();
    const modelCode = String(latest.model || '').toUpperCase();

    return modelName.includes('drive') || modelCode === 'FBX2D';
  }

  private getDriveStatus(latest: any, isDriveModel: boolean): string {
    if (!isDriveModel) {
      return 'Not detected';
    }

    if (latest.last_drivelog) {
      return 'Drive model detected, recent activity';
    }

    return 'Drive model detected, no blower activity';
  }

  private getDriveSettingsSummary(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
      return '-';
    }

    try {
      const settings = JSON.parse(value);

      return Object.entries(settings)
        .map(([key, settingValue]) => `${key}: ${settingValue}`)
        .join(', ');
    } catch (error) {
      return value;
    }
  }

  private formatText(value: unknown): string {
    if (value === undefined || value === null || value === '') {
      return '-';
    }

    return String(value);
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