import { Injectable, NotFoundException, Scope } from '@nestjs/common';
import { IntegrationEntity, IntegrationRepository } from '@novu/dal';
import { IEmailProvider, ISmsProvider } from '@novu/stateless';
import { IMailHandler, ISmsHandler, MailFactory, SmsFactory } from '@novu/application-generic';
import { ChannelTypeEnum } from '@novu/shared';
import { GetWebhookSupportStatusCommand } from './get-webhook-support-status.command';
import { ApiException } from '../../../shared/exceptions/api.exception';

@Injectable({ scope: Scope.REQUEST })
export class GetWebhookSupportStatus {
  public readonly mailFactory = new MailFactory();
  public readonly smsFactory = new SmsFactory();
  private provider: IEmailProvider | ISmsProvider;

  constructor(private integrationRepository: IntegrationRepository) {}

  async execute(command: GetWebhookSupportStatusCommand): Promise<boolean> {
    const { providerId } = command;

    const integration = await this.getIntegration(command);
    if (!integration) {
      throw new NotFoundException(`Integration for ${providerId} was not found`);
    }

    const { channel } = integration;
    if (![ChannelTypeEnum.EMAIL, ChannelTypeEnum.SMS].includes(channel)) {
      throw new ApiException(`Webhook for ${providerId}-${channel} is not supported yet`);
    }

    this.createProvider(integration);

    if (!this.provider.getMessageId || !this.provider.parseEventBody) {
      return false;
    }

    return true;
  }
  private async getIntegration(command: GetWebhookSupportStatusCommand) {
    return await this.integrationRepository.findOne({
      _environmentId: command.environmentId,
      _organizationId: command.organizationId,
      providerId: command.providerId,
    });
  }

  private getHandler(integration: IntegrationEntity): ISmsHandler | IMailHandler | null {
    switch (integration.channel) {
      case 'sms':
        return this.smsFactory.getHandler(integration);
      default:
        return this.mailFactory.getHandler(integration);
    }
  }

  private createProvider(integration: IntegrationEntity) {
    const handler = this.getHandler(integration);
    if (!handler) {
      throw new NotFoundException(`Handler for integration of ${integration.providerId} was not found`);
    }

    handler.buildProvider(integration.credentials);

    this.provider = handler.getProvider();
  }
}
