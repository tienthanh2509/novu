import { ChannelTypeEnum } from '@novu/shared';
import { TermiiSmsProvider } from '@novu/termii';
import { ICredentials } from '@novu/dal';
import { BaseSmsHandler } from './base.handler';

export class TermiiSmsHandler extends BaseSmsHandler {
  constructor() {
    super('termii', ChannelTypeEnum.SMS);
  }

  buildProvider(credentials: ICredentials) {
    this.provider = new TermiiSmsProvider({ apiKey: credentials.apiKey, from: credentials.from });
  }
}
