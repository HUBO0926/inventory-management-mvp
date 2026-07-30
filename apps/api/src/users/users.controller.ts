import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsEnum, IsString, IsOptional, MaxLength, MinLength } from 'class-validator';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions, Roles } from '../auth/auth.decorators';
import { AuthUser, EntityStatus, Role } from '../common/constants';
import { UsersService } from './users.service';

class CreateUserDto {
  @IsString() @MaxLength(50) username: string;
  @IsOptional() @IsString() @MaxLength(100) employeeName?: string;
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsString() roleId: string;
  @IsString() @MinLength(8) @MaxLength(100) password: string;
  @IsOptional() @IsString() @MaxLength(50) employeeNo: string;
  @IsOptional() @IsString() @MaxLength(100) department: string;
  @IsOptional() @IsString() @MaxLength(100) position: string;
  @IsOptional() @IsString() @MaxLength(30) phone: string;
  @IsOptional() @IsString() @MaxLength(100) email: string;
  @IsOptional() @IsString() @MaxLength(500) remarks: string;
}

class UpdateUserDto {
  @IsOptional() @IsString() @MaxLength(100) employeeName: string;
  @IsOptional() @IsString() @MaxLength(50) employeeNo: string;
  @IsOptional() @IsString() @MaxLength(100) department: string;
  @IsOptional() @IsString() @MaxLength(100) position: string;
  @IsOptional() @IsString() @MaxLength(30) phone: string;
  @IsOptional() @IsString() @MaxLength(100) email: string;
  @IsOptional() @IsString() @MaxLength(500) remarks: string;
  @IsOptional() @IsEnum(EntityStatus) status: EntityStatus;
  @IsOptional() @IsString() roleId: string;
}

class StatusDto { @IsEnum(EntityStatus) status: EntityStatus; }
class PasswordDto { @IsString() @MinLength(8) @MaxLength(100) password: string; }

@ApiTags('账号')
@Controller('users')
export class UsersController {
  constructor(private readonly service: UsersService) {}

  @Get('me')
  me(@CurrentUser() u: AuthUser) { return this.service.me(u); }

  @Get()
  @Permissions('user.manage')
  list(@Query() q: any) { return this.service.list(q); }

  @Post()
  @Permissions('user.manage')
  create(@Body() dto: CreateUserDto, @CurrentUser() u: AuthUser) { return this.service.create(dto, u.id, u); }

  @Patch(':id')
  @Permissions('user.manage')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() u: AuthUser) { return this.service.update(id, dto, u.id); }

  @Patch(':id/status')
  @Permissions('user.manage')
  status(@Param('id') id: string, @Body() dto: StatusDto, @CurrentUser() u: AuthUser) { return this.service.status(id, dto.status, u.id); }

  @Post(':id/reset-password')
  @Permissions('user.manage')
  reset(@Param('id') id: string, @Body() dto: PasswordDto, @CurrentUser() u: AuthUser) { return this.service.reset(id, dto.password, u.id); }

  @Post(':id/delete')
  @Permissions('user.manage')
  remove(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.service.remove(id, u.id); }
}
