import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Permissions } from '../auth/auth.decorators';
import { EntityStatus } from '../common/constants';
import { RolesService } from './roles.service';
class RoleDto{@IsString()@MaxLength(50)code:string;@IsString()@MaxLength(100)name:string;@IsArray()@ArrayUnique()permissions:string[]}
class RoleUpdateDto{@IsOptional()@IsString()@MaxLength(100)name?:string;@IsOptional()@IsEnum(EntityStatus)status?:EntityStatus;@IsOptional()@IsArray()@ArrayUnique()permissions?:string[]}
@ApiTags('角色权限')@Controller()
export class RolesController{constructor(private s:RolesService){}
  @Permissions('role.manage')@Get('roles')list(){return this.s.list()}
  @Permissions('role.manage')@Get('permissions')permissions(){return this.s.permissions()}
  @Permissions('role.manage')@Post('roles')create(@Body()d:RoleDto){return this.s.create(d)}
  @Permissions('role.manage')@Patch('roles/:id')update(@Param('id')id:string,@Body()d:RoleUpdateDto){return this.s.update(id,d)}
  @Permissions('role.manage')@Delete('roles/:id')remove(@Param('id')id:string){return this.s.remove(id)}
}
