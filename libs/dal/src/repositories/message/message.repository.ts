import { ChannelTypeEnum } from '@novu/shared';
import { SoftDeleteModel } from 'mongoose-delete';
import { FilterQuery, Types } from 'mongoose';

import { BaseRepository } from '../base-repository';
import { MessageEntity, MessageDBModel } from './message.entity';
import { Message } from './message.schema';
import { FeedRepository } from '../feed';
import { DalException } from '../../shared';

type MessageQuery = FilterQuery<MessageDBModel>;

export class MessageRepository extends BaseRepository<MessageDBModel, MessageEntity> {
  private message: SoftDeleteModel;
  private feedRepository = new FeedRepository();
  constructor() {
    super(Message, MessageEntity);
    this.message = Message;
  }

  private async getFilterQueryForMessage(
    environmentId: string,
    subscriberId: string,
    channel: ChannelTypeEnum,
    query: { feedId?: string[]; seen?: boolean; read?: boolean } = {},
    options: { limit: number; skip?: number } = { limit: 10 }
  ): Promise<MessageQuery> {
    const requestQuery: MessageQuery = {
      _environmentId: environmentId,
      _subscriberId: subscriberId,
      channel,
    };

    if (query.feedId === null) {
      requestQuery._feedId = { $eq: null };
    }

    if (query.feedId) {
      const feeds = await this.feedRepository.find(
        {
          _environmentId: environmentId,
          identifier: {
            $in: query.feedId,
          },
        },
        '_id'
      );
      requestQuery._feedId = {
        $in: feeds.map((feed) => feed._id),
      };
    }

    if (query.seen != null) {
      requestQuery.seen = query.seen;
    }

    if (query.read != null) {
      requestQuery.read = query.read;
    }

    return requestQuery;
  }

  async findBySubscriberChannel(
    environmentId: string,
    subscriberId: string,
    channel: ChannelTypeEnum,
    query: { feedId?: string[]; seen?: boolean; read?: boolean } = {},
    options: { limit: number; skip?: number } = { limit: 10 }
  ) {
    const requestQuery = await this.getFilterQueryForMessage(environmentId, subscriberId, channel, query);
    const messages = await this.MongooseModel.find(requestQuery, '', {
      limit: options.limit,
      skip: options.skip,
      sort: '-createdAt',
    }).populate('subscriber', '_id firstName lastName avatar subscriberId');

    return this.mapEntities(messages);
  }

  async getTotalCount(
    environmentId: string,
    subscriberId: string,
    channel: ChannelTypeEnum,
    query: { feedId?: string[]; seen?: boolean } = {}
  ) {
    const requestQuery = await this.getFilterQueryForMessage(environmentId, subscriberId, channel, query);

    return await this.count(requestQuery);
  }

  async getCount(
    environmentId: string,
    subscriberId: string,
    channel: ChannelTypeEnum,
    query: { feedId?: string[]; seen?: boolean; read?: boolean } = {}
  ) {
    const requestQuery = await this.getFilterQueryForMessage(environmentId, subscriberId, channel, {
      feedId: query.feedId,
      seen: query.seen,
      read: query.read,
    });

    return await this.count(requestQuery);
  }

  async markAllUnseenAsSeen(subscriberId: string, environmentId: string) {
    return this.update(
      { _subscriberId: subscriberId, _environmentId: environmentId, seen: false },
      { $set: { seen: true, lastSeenDate: new Date() } }
    );
  }

  async updateFeedByMessageTemplateId(environmentId: string, messageId: string, feedId?: string | null) {
    return this.update(
      { _environmentId: environmentId, _messageTemplateId: messageId },
      {
        $set: {
          _feedId: feedId,
        },
      }
    );
  }

  async updateMessageStatus(
    environmentId: string,
    id: string,
    status: 'error' | 'sent' | 'warning',
    // eslint-disable-next-line
    providerPayload: any = {},
    errorId: string,
    errorText: string
  ) {
    return await this.update(
      {
        _environmentId: environmentId,
        _id: id,
      },
      {
        $set: {
          status,
          errorId,
          errorText,
          providerPayload,
        },
      }
    );
  }

  async getActivityGraphStats(date: Date, environmentId: string) {
    return await this.aggregate([
      {
        $match: {
          createdAt: { $gte: date },
          _environmentId: new Types.ObjectId(environmentId),
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
          },
          count: {
            $sum: 1,
          },
        },
      },
      { $sort: { _id: -1 } },
    ]);
  }

  async getFeed(
    environmentId: string,
    query: { channels?: ChannelTypeEnum[]; templates?: string[]; emails?: string[]; _subscriberId?: string } = {},
    skip = 0,
    limit = 10
  ) {
    const requestQuery: MessageQuery = {
      _environmentId: environmentId,
    };

    if (query?.channels) {
      requestQuery.channel = {
        $in: query.channels,
      };
    }

    if (query?.templates) {
      requestQuery._templateId = {
        $in: query.templates,
      };
    }

    if (query?.emails) {
      requestQuery.email = {
        $in: query.emails,
      };
    }

    if (query?._subscriberId) {
      requestQuery._subscriberId = query?._subscriberId;
    }

    const totalCount = await this.count(requestQuery);
    const response = await this.MongooseModel.find(requestQuery)
      .populate('subscriber', 'firstName _id lastName email')
      .populate('template', 'name _id')
      .skip(skip)
      .limit(limit)
      .sort('-createdAt');

    return {
      totalCount,
      data: this.mapEntities(response),
    };
  }

  async changeStatus(
    environmentId: string,
    subscriberId: string,
    messageIds: string[],
    mark: { seen?: boolean; read?: boolean }
  ) {
    const requestQuery: FilterQuery<MessageEntity> = {};

    if (mark.seen != null) {
      requestQuery.seen = mark.seen;
      requestQuery.lastSeenDate = new Date();
    }

    if (mark.read != null) {
      requestQuery.read = mark.read;
      requestQuery.lastReadDate = new Date();
    }

    await this.update(
      {
        _environmentId: environmentId,
        _subscriberId: subscriberId,
        _id: {
          $in: messageIds.map((id) => {
            return new Types.ObjectId(id);
          }),
        },
      },
      {
        $set: requestQuery,
      }
    );
  }

  async delete(query: MessageQuery) {
    const message = await this.findOne({
      _id: query._id,
      _environmentId: query._environmentId,
    });

    if (!message) {
      throw new DalException(`Could not find a message with id ${query._id}`);
    }

    await this.message.delete({ _id: message._id, _environmentId: message._environmentId });
  }

  async findDeleted(query: MessageQuery): Promise<MessageEntity> {
    const res: MessageEntity = await this.message.findDeleted(query);

    return this.mapEntity(res);
  }

  async findMessageById(query: { _id: string; _environmentId: string }): Promise<MessageEntity | null> {
    const res = await this.MongooseModel.findOne({ _id: query._id, _environmentId: query._environmentId }).populate(
      'subscriber'
    );

    return this.mapEntity(res);
  }
}
