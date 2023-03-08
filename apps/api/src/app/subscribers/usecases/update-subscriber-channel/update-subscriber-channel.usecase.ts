import { Injectable } from '@nestjs/common';
import { isEqual } from 'lodash';
import { IChannelSettings, SubscriberRepository, IntegrationRepository, SubscriberEntity } from '@novu/dal';
import { ApiException } from '../../../shared/exceptions/api.exception';
import { UpdateSubscriberChannelCommand } from './update-subscriber-channel.command';
import { CacheKeyPrefixEnum, InvalidateCacheService } from '../../../shared/services/cache';

@Injectable()
export class UpdateSubscriberChannel {
  constructor(
    private invalidateCache: InvalidateCacheService,
    private subscriberRepository: SubscriberRepository,
    private integrationRepository: IntegrationRepository
  ) {}

  async execute(command: UpdateSubscriberChannelCommand) {
    const foundSubscriber = await this.subscriberRepository.findBySubscriberId(
      command.environmentId,
      command.subscriberId
    );

    if (!foundSubscriber) {
      throw new ApiException(`SubscriberId: ${command.subscriberId} not found`);
    }

    const foundIntegration = await this.integrationRepository.findOne({
      _environmentId: command.environmentId,
      providerId: command.providerId,
      active: true,
    });

    if (!foundIntegration) {
      throw new ApiException(
        `Subscribers environment (${command.environmentId}) do not have active ${command.providerId} integration.`
      );
    }
    const updatePayload = this.createUpdatePayload(command);

    const existingChannel = foundSubscriber?.channels?.find(
      (subscriberChannel) => subscriberChannel.providerId === command.providerId
    );

    if (existingChannel) {
      await this.updateExistingSubscriberChannel(
        command.environmentId,
        existingChannel,
        updatePayload,
        foundSubscriber
      );
    } else {
      await this.addChannelToSubscriber(updatePayload, foundIntegration, command, foundSubscriber);
    }

    return (await this.subscriberRepository.findBySubscriberId(
      command.environmentId,
      command.subscriberId
    )) as SubscriberEntity;
  }

  private async addChannelToSubscriber(
    updatePayload: Partial<IChannelSettings>,
    foundIntegration,
    command: UpdateSubscriberChannelCommand,
    foundSubscriber
  ) {
    updatePayload._integrationId = foundIntegration._id;
    updatePayload.providerId = command.providerId;

    await this.invalidateCache.clearCache({
      storeKeyPrefix: CacheKeyPrefixEnum.SUBSCRIBER,
      credentials: { _id: foundSubscriber._id, _environmentId: foundSubscriber._environmentId },
    });

    await this.subscriberRepository.update(
      { _environmentId: command.environmentId, _id: foundSubscriber },
      {
        $push: {
          channels: updatePayload,
        },
      }
    );
  }

  private async updateExistingSubscriberChannel(
    environmentId: string,
    existingChannel,
    updatePayload: Partial<IChannelSettings>,
    foundSubscriber
  ) {
    const equal = isEqual(existingChannel.credentials, updatePayload.credentials); // returns false if different

    if (equal) {
      return;
    }

    await this.invalidateCache.clearCache({
      storeKeyPrefix: CacheKeyPrefixEnum.SUBSCRIBER,
      credentials: { _id: foundSubscriber._id, _environmentId: foundSubscriber._environmentId },
    });

    const mergedChannel = Object.assign(existingChannel, updatePayload);

    await this.subscriberRepository.update(
      {
        _environmentId: environmentId,
        _id: foundSubscriber,
        'channels._integrationId': existingChannel._integrationId,
      },
      { $set: { 'channels.$': mergedChannel } }
    );
  }

  private createUpdatePayload(command: UpdateSubscriberChannelCommand) {
    const updatePayload: Partial<IChannelSettings> = {
      credentials: {},
    };

    if (command.credentials != null) {
      if (command.credentials.webhookUrl != null && updatePayload.credentials) {
        updatePayload.credentials.webhookUrl = command.credentials.webhookUrl;
      }
      if (command.credentials.deviceTokens != null && updatePayload.credentials) {
        updatePayload.credentials.deviceTokens = command.credentials.deviceTokens;
      }
      if (command.credentials.channel != null && updatePayload.credentials) {
        updatePayload.credentials.channel = command.credentials.channel;
      }
    }

    return updatePayload;
  }
}
