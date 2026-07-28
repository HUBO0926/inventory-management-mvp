import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { AppModule } from './app.module';

export function configureApp(app:any){
  const uploadRoot=resolve(process.env.UPLOAD_ROOT||'/app/uploads');
  mkdirSync(uploadRoot,{recursive:true});
  if(typeof app.useStaticAssets==='function')app.useStaticAssets(uploadRoot,{
    prefix:'/uploads/',
    setHeaders:(response:any)=>response.setHeader('Cache-Control','public, max-age=31536000, immutable'),
  });
  app.setGlobalPrefix('api');
  app.enableCors({origin:true,credentials:true});
  app.useGlobalPipes(new ValidationPipe({
    whitelist:true,transform:true,forbidNonWhitelisted:true,
    exceptionFactory:errors=>new BadRequestException({
      code:'VALIDATION_ERROR',
      message:'请求参数校验失败',
      details:errors.map(error=>({field:error.property,message:`字段 ${error.property} 格式不正确`})),
    }),
  }));
}
async function bootstrap(){
  const app=await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  const version=require('../../../package.json').version;
  const config=new DocumentBuilder()
    .setTitle('库存管理系统 API')
    .setDescription('新建业务单据编号使用“业务前缀-YYYYMMDDHHmmss”，时间为北京时间；同类型同秒重复时追加最少两位序号。')
    .setVersion(version)
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs',app,SwaggerModule.createDocument(app,config));
  await app.listen(Number(process.env.API_PORT||3001),'0.0.0.0');
}
if(require.main===module)bootstrap();
