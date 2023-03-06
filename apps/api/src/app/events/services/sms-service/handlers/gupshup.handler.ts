import { ChannelTypeEnum } from '@novu/shared';
import { ICredentials } from '@novu/dal';
import { BaseSmsHandler } from './base.handler';
import { GupshupSmsProvider } from '@novu/gupshup';

export class GupshupSmsHandler extends BaseSmsHandler {
  constructor() {
    super('Gupshup', ChannelTypeEnum.SMS);
  }

  buildProvider(credentials: ICredentials) {
    this.provider = new GupshupSmsProvider({ userId: credentials.user, password: credentials.password });
  }
}
