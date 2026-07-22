import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthUser, EntityStatus, Role } from '../common/constants';
import { UsersService } from './users.service';

class CreateUserDto { @IsString() @MaxLength(50) username: string; @IsString() @MaxLength(100) name: string; @IsEnum(Role) role: Role; @IsString() @MinLength(8) @MaxLength(100) password: string; }
class StatusDto { @IsEnum(EntityStatus) status: EntityStatus; }
class PasswordDto { @IsString() @MinLength(8) @MaxLength(100) password: string; }

@ApiTags('账号') @Roles(Role.ADMIN) @Controller('users')
export class UsersController {
  constructor(private readonly service: UsersService) {}
  @Get() list(@Query() q: any) { return this.service.list(q); }
  @Post() create(@Body() dto: CreateUserDto, @CurrentUser() u: AuthUser) { return this.service.create(dto, u.id); }
  @Patch(':id/status') status(@Param('id') id: string, @Body() dto: StatusDto, @CurrentUser() u: AuthUser) { return this.service.status(id, dto.status, u.id); }
  @Post(':id/reset-password') reset(@Param('id') id: string, @Body() dto: PasswordDto, @CurrentUser() u: AuthUser) { return this.service.reset(id, dto.password, u.id); }
}
