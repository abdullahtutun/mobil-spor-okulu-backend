import { Module } from '@nestjs/common';
import { AccountDeletionService } from './account-deletion.service';
import { AccountsRepository } from './accounts.repository';
import { CallerResolver } from './caller';
import {
  AuthorizationHeaderGuard,
  FunctionsController,
} from './functions.controller';
import { ParentAccountsService } from './parent-accounts.service';
import { StaffAccountsService } from './staff-accounts.service';

/**
 * S09: hesap işlemleri — ex `create-user`, `update-user`, `create-parent`,
 * `update-parent`, `delete-account` Edge Function'ları
 * (`docs/api/functions.md`). Auth kullanıcılarını `AuthAdminService` açar/
 * siler; yetkiyi SQL (save_staff_profile, has_permission, can_manage_parent,
 * RLS) verir.
 */
@Module({
  controllers: [FunctionsController],
  providers: [
    AccountsRepository,
    CallerResolver,
    StaffAccountsService,
    ParentAccountsService,
    AccountDeletionService,
    AuthorizationHeaderGuard,
  ],
})
export class AccountsModule {}
