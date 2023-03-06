import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  MessageTemplateRepository,
  NotificationTemplateRepository,
  SubscriberPreferenceRepository,
  NotificationTemplateEntity,
  MemberRepository,
} from '@novu/dal';
import { IPreferenceChannels } from '@novu/shared';
import { AnalyticsService } from '@novu/application-generic';

import { GetSubscriberPreferenceCommand } from './get-subscriber-preference.command';
import {
  GetSubscriberTemplatePreference,
  GetSubscriberTemplatePreferenceCommand,
} from '../get-subscriber-template-preference';
import { ANALYTICS_SERVICE } from '../../../shared/shared.module';

@Injectable()
export class GetSubscriberPreference {
  constructor(
    private memberRepository: MemberRepository,
    private subscriberPreferenceRepository: SubscriberPreferenceRepository,
    private notificationTemplateRepository: NotificationTemplateRepository,
    private messageTemplateRepository: MessageTemplateRepository,
    private getSubscriberTemplatePreferenceUsecase: GetSubscriberTemplatePreference,
    @Inject(ANALYTICS_SERVICE) private analyticsService: AnalyticsService
  ) {}

  async execute(command: GetSubscriberPreferenceCommand): Promise<ISubscriberPreferenceResponse[]> {
    const admin = await this.memberRepository.getOrganizationAdminAccount(command.organizationId);

    const templateList = await this.notificationTemplateRepository.getActiveList(
      command.organizationId,
      command.environmentId,
      true
    );

    if (admin) {
      this.analyticsService.track('Fetch User Preferences - [Notification Center]', admin._userId, {
        _organization: command.organizationId,
        templatesSize: templateList.length,
      });
    }

    return await Promise.all(templateList.map(async (template) => this.getTemplatePreference(template, command)));
  }

  async getTemplatePreference(template: NotificationTemplateEntity, command: GetSubscriberPreferenceCommand) {
    const buildCommand = GetSubscriberTemplatePreferenceCommand.create({
      organizationId: command.organizationId,
      subscriberId: command.subscriberId,
      environmentId: command.environmentId,
      template,
    });

    return await this.getSubscriberTemplatePreferenceUsecase.execute(buildCommand);
  }
}

export interface ISubscriberPreferenceResponse {
  template: IGetSubscriberPreferenceTemplateResponse;
  preference: {
    enabled: boolean;
    channels: IPreferenceChannels;
  };
}

export interface IGetSubscriberPreferenceTemplateResponse {
  _id: string;
  name: string;
  critical: boolean;
}
