import { ChannelTypeEnum } from '@novu/shared';
import { PlivoSmsProvider } from '@novu/plivo';
import { ICredentials } from '@novu/dal';
import { BaseSmsHandler } from './base.handler';

export class PlivoHandler extends BaseSmsHandler {
  constructor() {
    super('plivo', ChannelTypeEnum.SMS);
  }
  buildProvider(credentials: ICredentials) {
    this.provider = new PlivoSmsProvider({
      accountSid: credentials.accountSid,
      authToken: credentials.token,
      from: credentials.from,
    });
  }
}
