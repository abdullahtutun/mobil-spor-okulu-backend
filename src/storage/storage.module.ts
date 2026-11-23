import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { StorageRepository } from './storage.repository';
import { StorageService } from './storage.service';

/** Dosya deposu (S08, K9): athlete-photos, school-logos. */
@Module({
  controllers: [StorageController],
  providers: [StorageService, StorageRepository],
  exports: [StorageService],
})
export class StorageModule {}
