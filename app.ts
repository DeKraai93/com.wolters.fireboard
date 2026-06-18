'use strict';

import Homey from 'homey';
import Logger from './lib/Logger';

type ProbeArg = {
  id: string;
  name: string;
};

class MyApp extends Homey.App {
  async onInit(): Promise<void> {
    Logger.app('FireBoard app has been initialized');

    this.registerProbeConditionCard('probe_temperature_above', 'above');
    this.registerProbeConditionCard('probe_temperature_below', 'below');
  }

  private getFireBoardDevice(args?: any): any {
    if (args?.device) {
      return args.device;
    }

    const driver: any = this.homey.drivers.getDriver('fireboard');
    const devices: any[] = driver.getDevices();

    return devices[0];
  }

  private getProbeAutocompleteListener() {
    return async (query: string): Promise<ProbeArg[]> => {
      const device = this.getFireBoardDevice();
      const probes: ProbeArg[] = [];

      for (let probe = 1; probe <= 6; probe++) {
        let name = `Probe ${probe}`;

        if (device) {
          const storedLabel = device.getStoreValue(`probe${probe}_label`);

          if (typeof storedLabel === 'string' && storedLabel.length > 0) {
            name = storedLabel;
          }
        }

        probes.push({
          id: String(probe),
          name,
        });
      }

      const normalizedQuery = query.toLowerCase();

      return probes.filter(probe =>
        probe.name.toLowerCase().includes(normalizedQuery)
        || probe.id.includes(normalizedQuery),
      );
    };
  }

  private registerProbeConditionCard(
    cardId: string,
    mode: 'above' | 'below',
  ): void {
    const card = this.homey.flow.getConditionCard(cardId);

    card.registerArgumentAutocompleteListener(
      'probe',
      this.getProbeAutocompleteListener(),
    );

    card.registerRunListener(async (args: any): Promise<boolean> => {
      const probe = String(args.probe.id);
      const threshold = Number(args.temperature);
      const device = this.getFireBoardDevice(args);

      if (!device) {
        return false;
      }

      const value = device.getCapabilityValue(
        `measure_temperature_probe${probe}`,
      );

      if (typeof value !== 'number') {
        return false;
      }

      return mode === 'above'
        ? value > threshold
        : value < threshold;
    });
  }
}

module.exports = MyApp;