/*
 * Copyright (C) 2026 Fluxer Contributors
 *
 * This file is part of Fluxer.
 *
 * Fluxer is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Fluxer is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Fluxer. If not, see <https://www.gnu.org/licenses/>.
 */

import {Config} from '@fluxer/api/src/Config';
import type {AssetDeletionQueue} from '@fluxer/api/src/infrastructure/AssetDeletionQueue';
import type {IPurgeQueue} from '@fluxer/api/src/infrastructure/CloudflarePurgeQueue';
import type {QueuedAssetDeletion} from '@fluxer/api/src/infrastructure/IAssetDeletionQueue';
import type {IStorageService} from '@fluxer/api/src/infrastructure/IStorageService';
import {Logger} from '@fluxer/api/src/Logger';
import {getWorkerDependencies} from '@fluxer/api/src/worker/WorkerContext';
import type {GuildRepository} from '@fluxer/api/src/guild/repositories/GuildRepository';
import type {UserRepository} from '@fluxer/api/src/user/repositories/UserRepository';
import type {WorkerTaskHandler} from '@fluxer/worker/src/contracts/WorkerTask';

const BATCH_SIZE = 50;
const MAX_ITEMS_PER_RUN = 500;
const USER_ASSET_KEY_REGEX = /^(avatars|banners)\/(\d+)\/([0-9a-f]{8})$/;
const GUILD_ASSET_KEY_REGEX = /^(icons|banners|splashes|embed-splashes)\/(\d+)\/([0-9a-f]{8})$/;
const GUILD_MEMBER_ASSET_KEY_REGEX = /^guilds\/(\d+)\/users\/(\d+)\/(avatars|banners)\/([0-9a-f]{8})$/;

interface ReferenceRepositories {
	userRepository: Pick<UserRepository, 'findUnique'>;
	guildRepository: Pick<GuildRepository, 'findUnique' | 'getMember'>;
}

function stripAnimationPrefix(hash: string | null | undefined): string | null {
	if (!hash) {
		return null;
	}

	return hash.startsWith('a_') ? hash.substring(2) : hash;
}

async function isKeyStillReferencedByEntity(s3Key: string, repositories: ReferenceRepositories): Promise<boolean> {
	const userAssetMatch = s3Key.match(USER_ASSET_KEY_REGEX);
	if (userAssetMatch) {
		const prefix = userAssetMatch[1]!;
		const userId = BigInt(userAssetMatch[2]!);
		const hashWithoutAnimationPrefix = userAssetMatch[3]!;
		const user = await repositories.userRepository.findUnique(userId as never);
		if (!user) {
			return false;
		}

		const activeHash = prefix === 'avatars' ? user.avatarHash : user.bannerHash;
		return stripAnimationPrefix(activeHash) === hashWithoutAnimationPrefix;
	}

	const guildAssetMatch = s3Key.match(GUILD_ASSET_KEY_REGEX);
	if (guildAssetMatch) {
		const prefix = guildAssetMatch[1]!;
		const guildId = BigInt(guildAssetMatch[2]!);
		const hashWithoutAnimationPrefix = guildAssetMatch[3]!;
		const guild = await repositories.guildRepository.findUnique(guildId as never);
		if (!guild) {
			return false;
		}

		switch (prefix) {
			case 'icons':
				return stripAnimationPrefix(guild.iconHash) === hashWithoutAnimationPrefix;
			case 'banners':
				return stripAnimationPrefix(guild.bannerHash) === hashWithoutAnimationPrefix;
			case 'splashes':
				return stripAnimationPrefix(guild.splashHash) === hashWithoutAnimationPrefix;
			case 'embed-splashes':
				return stripAnimationPrefix(guild.embedSplashHash) === hashWithoutAnimationPrefix;
			default:
				return false;
		}
	}

	const guildMemberAssetMatch = s3Key.match(GUILD_MEMBER_ASSET_KEY_REGEX);
	if (guildMemberAssetMatch) {
		const guildId = BigInt(guildMemberAssetMatch[1]!);
		const userId = BigInt(guildMemberAssetMatch[2]!);
		const prefix = guildMemberAssetMatch[3]!;
		const hashWithoutAnimationPrefix = guildMemberAssetMatch[4]!;
		const member = await repositories.guildRepository.getMember(guildId as never, userId as never);
		if (!member) {
			return false;
		}

		const activeHash = prefix === 'avatars' ? member.avatarHash : member.bannerHash;
		return stripAnimationPrefix(activeHash) === hashWithoutAnimationPrefix;
	}

	return false;
}

async function shouldSkipS3Deletion(
	item: QueuedAssetDeletion,
	storageService: IStorageService,
	repositories: ReferenceRepositories,
): Promise<boolean> {
	if (!item.s3Key || item.queuedAt === undefined) {
		return false;
	}

	const stillReferenced = await isKeyStillReferencedByEntity(item.s3Key, repositories);
	if (stillReferenced) {
		Logger.info(
			{
				s3Key: item.s3Key,
				reason: item.reason,
			},
			'Skipping stale asset deletion because key is still referenced by entity',
		);
		return true;
	}

	const metadata = await storageService.getObjectMetadata(Config.s3.buckets.cdn, item.s3Key);
	if (!metadata?.lastModified) {
		return false;
	}

	const lastModifiedMs = metadata.lastModified.getTime();
	if (lastModifiedMs > item.queuedAt) {
		Logger.info(
			{
				s3Key: item.s3Key,
				reason: item.reason,
				queuedAt: new Date(item.queuedAt).toISOString(),
				lastModified: metadata.lastModified.toISOString(),
			},
			'Skipping stale asset deletion because object was modified after queueing',
		);
		return true;
	}

	return false;
}

const processAssetDeletionQueue: WorkerTaskHandler = async (_payload, _helpers) => {
	const {assetDeletionQueue, purgeQueue, storageService, userRepository, guildRepository} = getWorkerDependencies();

	const queueSize = await assetDeletionQueue.getQueueSize();
	if (queueSize === 0) {
		Logger.debug('Asset deletion queue is empty');
		return;
	}

	Logger.info({queueSize}, 'Starting asset deletion queue processing');

	let totalProcessed = 0;
	let totalDeleted = 0;
	let totalFailed = 0;
	let totalCdnPurged = 0;

	while (totalProcessed < MAX_ITEMS_PER_RUN) {
		const batch = await assetDeletionQueue.getBatch(BATCH_SIZE);
		if (batch.length === 0) {
			break;
		}

		const results = await Promise.allSettled(
			batch.map((item) =>
				processItem(
					item,
					storageService,
					purgeQueue,
					assetDeletionQueue,
					{
						userRepository,
						guildRepository,
					},
				),
			),
		);

		for (let i = 0; i < results.length; i++) {
			const result = results[i]!;
			const item = batch[i]!;

			if (result.status === 'fulfilled') {
				totalDeleted++;
				if (item.cdnUrl) {
					totalCdnPurged++;
				}
			} else {
				totalFailed++;
				Logger.error(
					{error: result.reason, s3Key: item.s3Key, cdnUrl: item.cdnUrl},
					'Failed to process asset deletion',
				);
			}
		}

		totalProcessed += batch.length;
	}

	const remainingSize = await assetDeletionQueue.getQueueSize();

	Logger.info(
		{
			totalProcessed,
			totalDeleted,
			totalFailed,
			totalCdnPurged,
			remainingSize,
		},
		'Finished asset deletion queue processing',
	);

	if (totalFailed > 0) {
		throw new Error(
			`Asset deletion queue processing completed with ${totalFailed} failures out of ${totalProcessed} items`,
		);
	}
};

async function processItem(
	item: QueuedAssetDeletion,
	storageService: IStorageService,
	purgeQueue: IPurgeQueue,
	assetDeletionQueue: AssetDeletionQueue,
	repositories: ReferenceRepositories,
): Promise<void> {
	try {
		if (item.s3Key) {
			try {
				const skipS3Deletion = await shouldSkipS3Deletion(item, storageService, repositories);
				if (skipS3Deletion) {
					return;
				}

				await storageService.deleteObject(Config.s3.buckets.cdn, item.s3Key);
				Logger.debug({s3Key: item.s3Key, reason: item.reason}, 'Deleted asset from S3');
			} catch (error: unknown) {
				const isNotFound =
					error instanceof Error &&
					(('name' in error && error.name === 'NotFound') ||
						('code' in error && (error as {code?: string}).code === 'NoSuchKey'));

				if (!isNotFound) {
					throw error;
				}
				Logger.debug({s3Key: item.s3Key}, 'Asset already deleted from S3 (NotFound)');
			}
		}

		if (item.cdnUrl) {
			await purgeQueue.addUrls([item.cdnUrl]);
			Logger.debug({cdnUrl: item.cdnUrl}, 'Queued asset CDN URL for Cloudflare purge');
		}
	} catch (error) {
		await assetDeletionQueue.requeueItem(item);
		throw error;
	}
}

export default processAssetDeletionQueue;
