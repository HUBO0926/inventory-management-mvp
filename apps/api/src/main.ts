import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

export function configureApp(app:any){
  app.setGlobalPrefix('api');
  app.enableCors({origin:true,credentials:true});
  app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true,forbidNonWhitelisted:true}));
}
async function bootstrap(){const app=await NestFactory.create(AppModule);configureApp(app);const config=new DocumentBuilder().setTitle('库存管理系统 MVP API').setVersion('1.0').addBearerAuth().build();SwaggerModule.setup('api/docs',app,SwaggerModule.createDocument(app,config));await app.listen(Number(process.env.API_PORT||3001),'0.0.0.0');}
if(require.main===module)bootstrap();
