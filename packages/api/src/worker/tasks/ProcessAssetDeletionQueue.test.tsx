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

import type {QueuedAssetDeletion} from '@fluxer/api/src/infrastructure/IAssetDeletionQueue';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@fluxer/api/src/worker/WorkerContext';
import processAssetDeletionQueue from '@fluxer/api/src/worker/tasks/ProcessAssetDeletionQueue';
import {afterEach, describe, expect, it, vi} from 'vitest';

class TestAssetDeletionQueue {
	private items: Array<QueuedAssetDeletion>;
	readonly requeued: Array<QueuedAssetDeletion> = [];

	constructor(items: Array<QueuedAssetDeletion>) {
		this.items = [...items];
	}

	async queueDeletion(_item: Omit<QueuedAssetDeletion, 'queuedAt' | 'retryCount'>): Promise<void> {
		throw new Error('not implemented');
	}

	async queueCdnPurge(_cdnUrl: string): Promise<void> {
		throw new Error('not implemented');
	}

	async getBatch(count: number): Promise<Array<QueuedAssetDeletion>> {
		return this.items.splice(0, count);
	}

	async requeueItem(item: QueuedAssetDeletion): Promise<void> {
		this.requeued.push(item);
	}

	async getQueueSize(): Promise<number> {
		return this.items.length;
	}

	async clear(): Promise<void> {
		this.items = [];
	}
}

class TestStorageService {
	readonly deleteObjectSpy = vi.fn();
	readonly getObjectMetadataSpy = vi.fn();

	constructor(
		private readonly metadataByKey: Map<
			string,
			{
				contentLength: number;
				contentType: string;
				lastModified?: Date;
			}
		>,
	) {}

	async deleteObject(_bucket: string, key: string): Promise<void> {
		this.deleteObjectSpy(_bucket, key);
		this.metadataByKey.delete(key);
	}

	async getObjectMetadata(
		_bucket: string,
		key: string,
	): Promise<{contentLength: number; contentType: string; lastModified?: Date} | null> {
		this.getObjectMetadataSpy(_bucket, key);
		return this.metadataByKey.get(key) ?? null;
	}
}

class TestUserRepository {
	private readonly users = new Map<bigint, {avatarHash: string | null; bannerHash: string | null}>();

	setUser(userId: bigint, profile: {avatarHash: string | null; bannerHash: string | null}): void {
		this.users.set(userId, profile);
	}

	async findUnique(userId: bigint): Promise<{avatarHash: string | null; bannerHash: string | null} | null> {
		return this.users.get(userId) ?? null;
	}
}

class TestGuildRepository {
	private readonly guilds = new Map<
		bigint,
		{
			iconHash: string | null;
			bannerHash: string | null;
			splashHash: string | null;
			embedSplashHash: string | null;
		}
	>();
	private readonly members = new Map<string, {avatarHash: string | null; bannerHash: string | null}>();

	setGuild(
		guildId: bigint,
		guild: {
			iconHash: string | null;
			bannerHash: string | null;
			splashHash: string | null;
			embedSplashHash: string | null;
		},
	): void {
		this.guilds.set(guildId, guild);
	}

	setMember(guildId: bigint, userId: bigint, member: {avatarHash: string | null; bannerHash: string | null}): void {
		this.members.set(`${guildId}:${userId}`, member);
	}

	async findUnique(guildId: bigint): Promise<{
		iconHash: string | null;
		bannerHash: string | null;
		splashHash: string | null;
		embedSplashHash: string | null;
	} | null> {
		return this.guilds.get(guildId) ?? null;
	}

	async getMember(
		guildId: bigint,
		userId: bigint,
	): Promise<{avatarHash: string | null; bannerHash: string | null} | null> {
		return this.members.get(`${guildId}:${userId}`) ?? null;
	}
}

describe('ProcessAssetDeletionQueue', () => {
	afterEach(() => {
		clearWorkerDependencies();
	});

	it('deletes queued asset when object has not been modified since queueing', async () => {
		const queuedAt = Date.now();
		const item: QueuedAssetDeletion = {
			s3Key: 'avatars/123/abc12345',
			cdnUrl: 'https://example.com/media/avatars/123/abc12345.webp',
			reason: 'asset_replaced',
			queuedAt,
			retryCount: 0,
		};

		const queue = new TestAssetDeletionQueue([item]);
		const storage = new TestStorageService(
			new Map([
				[
					item.s3Key,
					{
						contentLength: 100,
						contentType: 'image/webp',
						lastModified: new Date(queuedAt - 60_000),
					},
				],
			]),
		);
		const purgeQueue = {
			addUrls: vi.fn(async (_urls: Array<string>) => {}),
		};
		const userRepository = new TestUserRepository();
		const guildRepository = new TestGuildRepository();

		setWorkerDependenciesForTest({
			assetDeletionQueue: queue as any,
			storageService: storage as any,
			purgeQueue: purgeQueue as any,
			userRepository: userRepository as any,
			guildRepository: guildRepository as any,
		});

		await processAssetDeletionQueue({}, {} as never);

		expect(storage.deleteObjectSpy).toHaveBeenCalledTimes(1);
		expect(storage.deleteObjectSpy).toHaveBeenCalledWith(expect.any(String), item.s3Key);
		expect(purgeQueue.addUrls).toHaveBeenCalledTimes(1);
		expect(queue.requeued).toHaveLength(0);
	});

	it('skips stale deletion when object was modified after queueing', async () => {
		const queuedAt = Date.now();
		const item: QueuedAssetDeletion = {
			s3Key: 'avatars/123/abc12345',
			cdnUrl: 'https://example.com/media/avatars/123/abc12345.webp',
			reason: 'asset_replaced',
			queuedAt,
			retryCount: 0,
		};

		const queue = new TestAssetDeletionQueue([item]);
		const storage = new TestStorageService(
			new Map([
				[
					item.s3Key,
					{
						contentLength: 100,
						contentType: 'image/webp',
						lastModified: new Date(queuedAt + 60_000),
					},
				],
			]),
		);
		const purgeQueue = {
			addUrls: vi.fn(async (_urls: Array<string>) => {}),
		};
		const userRepository = new TestUserRepository();
		const guildRepository = new TestGuildRepository();

		setWorkerDependenciesForTest({
			assetDeletionQueue: queue as any,
			storageService: storage as any,
			purgeQueue: purgeQueue as any,
			userRepository: userRepository as any,
			guildRepository: guildRepository as any,
		});

		await processAssetDeletionQueue({}, {} as never);

		expect(storage.deleteObjectSpy).not.toHaveBeenCalled();
		expect(purgeQueue.addUrls).not.toHaveBeenCalled();
		expect(queue.requeued).toHaveLength(0);
	});

	it('skips stale deletion when key is still referenced by current user profile', async () => {
		const queuedAt = Date.now();
		const item: QueuedAssetDeletion = {
			s3Key: 'avatars/123/abc12345',
			cdnUrl: 'https://example.com/media/avatars/123/abc12345.webp',
			reason: 'asset_replaced',
			queuedAt,
			retryCount: 0,
		};

		const queue = new TestAssetDeletionQueue([item]);
		const storage = new TestStorageService(
			new Map([
				[
					item.s3Key,
					{
						contentLength: 100,
						contentType: 'image/webp',
						lastModified: new Date(queuedAt - 60_000),
					},
				],
			]),
		);
		const purgeQueue = {
			addUrls: vi.fn(async (_urls: Array<string>) => {}),
		};
		const userRepository = new TestUserRepository();
		userRepository.setUser(123n, {avatarHash: 'abc12345', bannerHash: null});
		const guildRepository = new TestGuildRepository();

		setWorkerDependenciesForTest({
			assetDeletionQueue: queue as any,
			storageService: storage as any,
			purgeQueue: purgeQueue as any,
			userRepository: userRepository as any,
			guildRepository: guildRepository as any,
		});

		await processAssetDeletionQueue({}, {} as never);

		expect(storage.deleteObjectSpy).not.toHaveBeenCalled();
		expect(purgeQueue.addUrls).not.toHaveBeenCalled();
		expect(queue.requeued).toHaveLength(0);
	});
});
