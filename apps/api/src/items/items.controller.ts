import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { CurrentUser, Permissions } from '../auth/auth.decorators';
import { AuthUser } from '../common/constants';
import { CreateItemDto, ItemQueryDto, UpdateItemDto } from './items.dto';
import { ItemsService } from './items.service';

@ApiTags('物料档案')
@Controller()
export class ItemsController {
  constructor(private readonly service: ItemsService) {}

  @Get('items')
  @Permissions('item.view')
  list(@Query() q: ItemQueryDto) { return this.service.list(q); }

  @Get('materials')
  @Permissions('item.view')
  listMaterials(@Query() q: ItemQueryDto) { return this.service.list(q); }

  @Get('items/:id')
  @Permissions('item.view')
  get(@Param('id') id: string) { return this.service.get(id); }

  @Get('materials/:id')
  @Permissions('item.view')
  getMaterial(@Param('id') id: string) { return this.service.get(id); }

  @Post('items')
  @Permissions('item.manage')
  create(@Body() dto: CreateItemDto, @CurrentUser() u: AuthUser) { return this.service.create(dto, u); }

  @Post('materials')
  @Permissions('item.manage')
  createMaterial(@Body() dto: CreateItemDto, @CurrentUser() u: AuthUser) { return this.service.create(dto, u); }

  @Patch('items/:id')
  @Permissions('item.manage')
  update(@Param('id') id: string, @Body() dto: UpdateItemDto, @CurrentUser() u: AuthUser) { return this.service.update(id, dto, u); }

  @Patch('materials/:id')
  @Permissions('item.manage')
  updateMaterial(@Param('id') id: string, @Body() dto: UpdateItemDto, @CurrentUser() u: AuthUser) { return this.service.update(id, dto, u); }

  @Post('items/:id/delete')
  @Permissions('item.delete')
  remove(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.service.remove(id, u); }

  @Post('materials/:id/delete')
  @Permissions('item.delete')
  removeMaterial(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.service.remove(id, u); }

  @Post('items/:id/copy')
  @Permissions('item.manage')
  copy(@Param('id') id: string, @Body() dto: { itemCode: string }, @CurrentUser() u: AuthUser) { return this.service.copy(id, dto.itemCode, u); }

  @Post('materials/:id/copy')
  @Permissions('item.manage')
  copyMaterial(@Param('id') id: string, @Body() dto: { itemCode: string }, @CurrentUser() u: AuthUser) { return this.service.copy(id, dto.itemCode, u); }

  @Post('items/:id/image')
  @Permissions('item.manage')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  }))
  uploadImage(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() u: AuthUser,
  ) {
    return this.service.uploadImage(id, file, u);
  }

  @Delete('items/:id/image')
  @Permissions('item.manage')
  deleteImage(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.service.deleteImage(id, u);
  }

  // Material Parameters
  @Get('materials/:id/parameters')
  @Permissions('item.view')
  parameters(@Param('id') id: string) { return this.service.parameters(id); }

  @Post('materials/:id/parameters')
  @Permissions('material.parameter.manage')
  addParameter(@Param('id') id: string, @Body() dto: any, @CurrentUser() u: AuthUser) { return this.service.addParameter(id, dto, u); }

  @Patch('materials/:id/parameters/:paramId')
  @Permissions('material.parameter.manage')
  updateParameter(@Param('id') id: string, @Param('paramId') paramId: string, @Body() dto: any, @CurrentUser() u: AuthUser) { return this.service.updateParameter(id, paramId, dto, u); }

  @Delete('materials/:id/parameters/:paramId')
  @Permissions('material.parameter.manage')
  deleteParameter(@Param('id') id: string, @Param('paramId') paramId: string, @CurrentUser() u: AuthUser) { return this.service.deleteParameter(id, paramId, u); }

  @Put('materials/:id/parameters/sort')
  @Permissions('material.parameter.manage')
  sortParameters(@Param('id') id: string, @Body() dto: { ids: string[] }, @CurrentUser() u: AuthUser) { return this.service.sortParameters(id, dto.ids, u); }

  @Get('materials/:id/timeline')
  @Permissions('item.view')
  timeline(@Param('id') id: string) { return this.service.timeline(id); }
}
