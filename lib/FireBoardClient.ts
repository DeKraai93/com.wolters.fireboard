'use strict';

type FireBoardLoginResponse = {
  key?: string;
  auth_token?: string;
  token?: string;
};

export default class FireBoardClient {
  private readonly baseUrl = 'https://fireboard.io/api/v1';

  private getHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Homey-FireBoard-App',
      'Referer': 'https://fireboard.io/',
      'Origin': 'https://fireboard.io',
    };

    if (token) {
      headers.Authorization = `Token ${token}`;
    }

    return headers;
  }

  async login(username: string, password: string): Promise<string> {
    const response = await fetch('https://fireboard.io/api/rest-auth/login/', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ username, password }),
    });

    if (response.status === 401) {
      throw new Error('Ongeldige FireBoard e-mail of wachtwoord.');
    }

    if (response.status === 429) {
      throw new Error('FireBoard rate limit bereikt. Probeer later opnieuw.');
    }

    if (!response.ok) {
      throw new Error(`FireBoard login failed: ${response.status} ${response.statusText}`);
    }

    const json = await response.json() as FireBoardLoginResponse;
    const token = json.key || json.auth_token || json.token;

    if (!token) {
      throw new Error('FireBoard login response bevat geen token.');
    }

    return token;
  }

  async getDevices(token: string): Promise<any[]> {
    const response = await fetch(`${this.baseUrl}/devices.json`, {
      method: 'GET',
      headers: this.getHeaders(token),
    });

    if (!response.ok) {
      throw new Error(`FireBoard devices request failed: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();

    return Array.isArray(json) ? json : [];
  }

  async getDevice(token: string, deviceUuid: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/devices/${deviceUuid}.json`, {
      method: 'GET',
      headers: this.getHeaders(token),
    });

    if (!response.ok) {
      throw new Error(`FireBoard device request failed: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  }
}