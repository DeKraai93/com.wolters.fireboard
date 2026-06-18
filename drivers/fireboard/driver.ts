'use strict';

import Homey from 'homey';
import FireBoardClient from '../../lib/FireBoardClient';
import Logger from '../../lib/Logger';

module.exports = class FireBoardDriver extends Homey.Driver {
  private readonly client = new FireBoardClient();

  async onInit(): Promise<void> {
    Logger.driver('FireBoard driver has been initialized');
  }

  async onPair(session: any): Promise<void> {
    let token: string | null = null;
    let devices: any[] = [];

    session.setHandler('login', async (data: { username: string; password: string }) => {
      Logger.driver('Logging in to FireBoard:', data.username);

      token = await this.client.login(data.username, data.password);
      devices = await this.client.getDevices(token);

      Logger.object('FireBoard devices', devices);

      if (!devices.length) {
        throw new Error('Geen FireBoard apparaten gevonden.');
      }

      return true;
    });

    session.setHandler('list_devices', async () => {
      return devices.map((device: any) => ({
        name: device.model_name && device.hardware_id
          ? `${device.model_name} (${device.hardware_id})`
          : device.title || device.name || device.board_id || `FireBoard ${device.id || device.uuid}`,
        data: {
          id: String(device.uuid || device.id),
        },
        store: {
          token,
          device,
        },
      }));
    });
  }
};