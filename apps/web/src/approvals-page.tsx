import { useEffect, useState } from 'react';
import { Button, Card, Checkbox, Col, Descriptions, Drawer, Form, Input, InputNumber, Modal, Row, Select, Space, Statistic, Table, Tag, Typography, message } from 'antd';
import { CheckOutlined, CloseOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { api, idempotencyKey } from './api';
import { formatBeijingTime, formatQuantity, statusText } from './domain';
import { useIsMobile } from './responsive';
import { LocationName, locationDisplayName } from './location-name';
import type { User } from './App';

const safe=(value:any,fallback:any='—')=>value===undefined||value===null||value===''?fallback:value;
const docName=(value:any)=>statusText[value]||safe(value,'未知业务');
const receiptTypes=['MATERIAL_INBOUND','FINISHED_INBOUND','PRODUCTION_RETURN','PRODUCTION_COMPLETION'];
const approvalTabs:[string,string][]=[['pendingMine','待我审核'],['pendingAll','全部待审核'],['approved','我已审核'],['submitted','我提交的'],['rejected','已驳回'],['all','全部记录']];
const rejectReasons=['数量或库位信息不完整','库存或批次信息不正确','业务单据填写有误','其他原因'];
const actionText:Record<string,string>={RETURN:'退货',REPAIR_RESTOCK:'维修重新入库',RETURN_PRODUCTION:'退回生产任务'};

export function ApprovalsPage({user}:{user:User}) {
  const mobile=useIsMobile();
  const [mode,setMode]=useState<'approval'|'defective'|'records'>('approval');
  const [tab,setTab]=useState('pendingMine');
  const [stats,setStats]=useState<any>({});
  const [data,setData]=useState<any>({items:[],total:0});
  const [loading,setLoading]=useState(false);
  const [selected,setSelected]=useState<string[]>([]);
  const [detail,setDetail]=useState<any>();
  const [drawer,setDrawer]=useState(false);
  const [filters,setFilters]=useState<any>({});
  const [rejecting,setRejecting]=useState<'batch'|'single'>();
  const [allocationOpen,setAllocationOpen]=useState(false);
  const [capacityByKey,setCapacityByKey]=useState<Record<string,any>>({});
  const [processing,setProcessing]=useState<any>();
  const [onlyCheckDifferences,setOnlyCheckDifferences]=useState(false);
  const [rejectForm]=Form.useForm();
  const [allocationForm]=Form.useForm();
  const [processForm]=Form.useForm();
  const canApprove=user.role==='ADMIN'||Boolean(user.permissions?.includes('approval.approve'));
  const canReject=user.role==='ADMIN'||Boolean(user.permissions?.includes('approval.reject'));
  const canViewDefective=user.role==='ADMIN'||Boolean(user.permissions?.includes('approval.defective.view'));
  const canProcess=user.role==='ADMIN'||Boolean(user.permissions?.includes('approval.defective.process'));

  const load=async()=>{
    setLoading(true);
    try {
      if(mode==='approval'){
        const query=new URLSearchParams({tab,page:'1',pageSize:'20',...Object.fromEntries(Object.entries(filters).filter(([,v])=>v!==undefined&&v!=='')) as Record<string,string>});
        const [summary,list]=await Promise.all([api('/approvals/statistics'),api(`/approvals?${query}`)]);
        setStats(summary||{});setData(list||{items:[],total:0});
      } else {
        const query=new URLSearchParams({page:'1',pageSize:'50',...Object.fromEntries(Object.entries(filters).filter(([,v])=>v!==undefined&&v!=='')) as Record<string,string>});
        setData(await api(`/approvals/${mode==='defective'?'defective-items':'defective-records'}?${query}`));
      }
    } catch(error:any){message.error(error.message||'审核中心加载失败');}
    finally{setLoading(false);}
  };
  useEffect(()=>{void load();const timer=window.setInterval(load,60000);return()=>clearInterval(timer);},[mode,tab,JSON.stringify(filters)]);

  const open=async(id:string)=>{try{setOnlyCheckDifferences(false);setDetail(await api(`/approvals/${id}`));setDrawer(true);}catch(error:any){message.error(error.message);}};
  const submitApprove=async(payload:any={})=>{
    if(!detail)return;
    try{
      await api(`/approvals/${detail.id}/approve`,{method:'POST',headers:{'Idempotency-Key':idempotencyKey()},body:JSON.stringify(payload)});
      message.success('审核通过，库存已过账');setDrawer(false);setAllocationOpen(false);void load();
    }catch(error:any){message.error(error.message);}
  };
  const approve=async()=>{
    if(!detail)return;
    if(receiptTypes.includes(detail.documentType)){
      const options=detail.allocationOptions||[];
      const requests=new Map<string,{warehouseId:string;itemId:string;purpose:string}>();
      for(const line of detail.lines||[]){
        const normalType=line.itemType==='MATERIAL'?'RAW':'FG';
        for(const warehouse of options.filter((row:any)=>row.warehouseType===normalType)){
          requests.set(`${warehouse.warehouseId}:${line.itemId}:INBOUND`,{warehouseId:warehouse.warehouseId,itemId:line.itemId,purpose:'INBOUND'});
        }
      }
      try{const inventories=await Promise.all([...requests.entries()].map(async([key,params])=>[key,await api(`/stock-documents/item-location-inventory?${new URLSearchParams(params)}`)] as const));setCapacityByKey(current=>({...current,...Object.fromEntries(inventories)}));}catch(error:any){message.error(error?.message||'库位容量加载失败');return;}
      allocationForm.setFieldsValue({allocations:(detail.lines||[]).map((line:any)=>{
        const normalType=line.itemType==='MATERIAL'?'RAW':'FG';
        const normalTargets=options.filter((row:any)=>row.warehouseType===normalType);
        const preferred=normalTargets.find((row:any)=>row.warehouseId===detail.warehouseId&&row.locationId===line.locationId)||normalTargets[0];
        return {documentLineId:line.id,normalQty:Number(line.quantity),defectiveQty:0,normalWarehouseId:preferred?.warehouseId,normalLocationId:preferred?.locationId};
      })});
      setAllocationOpen(true);return;
    }
    Modal.confirm({title:'确认审核通过并立即过账？',content:'库存余额与不可修改流水将在同一事务内更新。',onOk:()=>submitApprove()});
  };
  const saveAllocations=async(values:any)=>{
    const payload:any[]=[];
    for(const row of values.allocations||[]){
      const line=detail.lines.find((item:any)=>item.id===row.documentLineId);
      const normal=Number(row.normalQty||0),defective=Number(row.defectiveQty||0),total=Number(line.quantity);
      if(!Number.isInteger(normal)||!Number.isInteger(defective)||normal<0||defective<0||normal+defective!==total){message.error(`${line.itemCode} 的正常品与不良品数量之和必须等于 ${formatQuantity(total)}`);return;}
      if(normal>0&&(!row.normalWarehouseId||!row.normalLocationId)){message.error(`${line.itemCode} 请选择正常入库仓库和库位`);return;}
      if(defective>0&&(!row.defectiveWarehouseId||!row.defectiveLocationId||!String(row.defectReason||'').trim())){message.error(`${line.itemCode} 请选择不良品仓库、库位并填写不良原因`);return;}
      if(normal>0)payload.push({documentLineId:line.id,disposition:'NORMAL',warehouseId:row.normalWarehouseId,locationId:row.normalLocationId,batchId:line.batchId||undefined,quantity:String(normal)});
      if(defective>0)payload.push({documentLineId:line.id,disposition:'DEFECTIVE',warehouseId:row.defectiveWarehouseId,locationId:row.defectiveLocationId,batchId:line.batchId||undefined,quantity:String(defective),defectReason:String(row.defectReason).trim()});
    }
    await submitApprove({receiptAllocations:payload});
  };
  const reject=async(values:any)=>{
    const ids=rejecting==='batch'?selected:detail?[detail.id]:[];
    if(!ids.length)return;
    try{
      const path=rejecting==='batch'?'/approvals/batch-reject':`/approvals/${ids[0]}/reject`;
      const body=rejecting==='batch'?{documentIds:ids,...values}:values;
      await api(path,{method:'POST',headers:{'Idempotency-Key':idempotencyKey()},body:JSON.stringify(body)});
      message.success('已驳回');setRejecting(undefined);setDrawer(false);setSelected([]);rejectForm.resetFields();void load();
    }catch(error:any){message.error(error.message);}
  };
  const process=async(values:any)=>{
    try{
      await api(`/approvals/defective-items/${processing.id}/process`,{method:'POST',headers:{'Idempotency-Key':idempotencyKey()},body:JSON.stringify({...values,quantity:String(values.quantity)})});
      message.success('不良品处理完成');setProcessing(undefined);processForm.resetFields();void load();window.dispatchEvent(new Event('inventory:refresh'));
    }catch(error:any){message.error(error.message);}
  };

  const approvalColumns:any[]=[
    {title:'单据编号',dataIndex:'documentNo',render:(value:any,row:any)=><Button type="link" onClick={()=>open(row.id)}>{safe(value,'未生成单号')}</Button>},
    {title:'业务类型',dataIndex:'documentType',render:docName},{title:'仓库',render:(_:any,row:any)=>`${safe(row.warehouseCode)} ${safe(row.warehouseName,'')}`},
    {title:'提交人',dataIndex:'submitterName',render:(value:any)=>safe(value,'未知')},{title:'提交时间',dataIndex:'submittedAt',render:formatBeijingTime},
    {title:'等待时长',render:(_:any,row:any)=>row.status==='SUBMITTED'?<>{safe(row.waitingMinutes,0)} 分钟 {Number(row.waitingMinutes||0)>=1440&&<Tag color="orange">超时</Tag>}</>:'-'},
    {title:'状态',dataIndex:'status',render:(value:any)=><Tag color={value==='SUBMITTED'?'blue':value==='REJECTED'?'red':value==='POSTED'?'green':'default'}>{statusText[value]||safe(value)}</Tag>},
    {title:'操作',render:(_:any,row:any)=><Button size="small" onClick={()=>open(row.id)}>详情</Button>},
  ];
  const defectiveColumns:any[]=[
    {title:'物料',render:(_:any,row:any)=>`${row.itemCode} ${row.itemName}`},{title:'类型',dataIndex:'itemType',render:(value:string)=>value==='MATERIAL'?'原材料':'成品'},
    {title:'不良品库位',render:(_:any,row:any)=><LocationName location={row}/>},{title:'来源单据',dataIndex:'sourceDocumentNo',render:safe},
    {title:'不良原因',dataIndex:'defectReason'},{title:'剩余数量',render:(_:any,row:any)=>`${formatQuantity(row.remainingQty)} ${row.unit}`},
    {title:'入库时间',dataIndex:'createdAt',render:formatBeijingTime},{title:'操作',render:(_:any,row:any)=>canProcess?<Button type="primary" size="small" onClick={()=>{setProcessing(row);processForm.resetFields();processForm.setFieldsValue({quantity:Number(row.remainingQty),action:row.itemType==='MATERIAL'?'RETURN':'RETURN_PRODUCTION',productionOrderId:row.productionOrderId});}}>处理</Button>:'-'},
  ];
  const stockCheckLines=(detail?.stockCheckLines||[]);
  const visibleStockCheckLines=onlyCheckDifferences?stockCheckLines.filter((row:any)=>Number(row.differenceQty)!==0):stockCheckLines;
  const stockCheckSummary=stockCheckLines.reduce((summary:any,row:any)=>{
    const difference=Number(row.differenceQty||0);
    summary.items.add(row.itemId||row.itemCode);
    if(difference===0)summary.consistent.add(row.itemId||row.itemCode);
    else {summary.different.add(row.itemId||row.itemCode);if(difference>0)summary.surplus.add(row.itemId||row.itemCode);else summary.loss.add(row.itemId||row.itemCode);}
    return summary;
  },{items:new Set<string>(),consistent:new Set<string>(),different:new Set<string>(),surplus:new Set<string>(),loss:new Set<string>()});
  const stockCheckColumns:any[]=[
    {title:'物料',render:(_:any,row:any)=><span>{row.itemCode} {row.itemName}{Number(row.differenceQty)!==0&&<Tag color="orange" style={{marginLeft:6}}>存在批次差异</Tag>}</span>},
    {title:'型号',dataIndex:'model',render:safe}, {title:'单位',dataIndex:'unit',render:safe}, {title:'库位',render:(_:any,row:any)=><LocationName location={row}/>}, {title:'批次',dataIndex:'batchNo',render:safe},
    {title:'账面数',dataIndex:'systemQtySnapshot',render:formatQuantity}, {title:'实盘数',dataIndex:'countedQty',render:formatQuantity},
    {title:'差异',dataIndex:'differenceQty',render:(value:any)=><span className={Number(value)>0?'positive':Number(value)<0?'negative':''}>{Number(value)>0?'+' : ''}{formatQuantity(value)}</span>},
    {title:'结果',render:(_:any,row:any)=>{const difference=Number(row.differenceQty);return <Tag color={difference===0?'green':difference>0?'blue':'orange'}>{difference===0?'一致':difference>0?'盘盈':'盘亏'}</Tag>; }},
  ];
  const recordColumns:any[]=[
    {title:'处理单号',dataIndex:'documentNo'},{title:'物料',render:(_:any,row:any)=>`${row.itemCode} ${row.itemName}`},{title:'处理方式',dataIndex:'action',render:(value:string)=>actionText[value]||value},
    {title:'数量',render:(_:any,row:any)=>`${formatQuantity(row.quantity)} ${row.unit}`},{title:'处理意见',dataIndex:'reason'},
    {title:'目标',render:(_:any,row:any)=>row.productionOrderNo||[row.targetWarehouseCode,row.targetLocationCode].filter(Boolean).join(' / ')||'-'},
    {title:'处理人',dataIndex:'processedByName',render:safe},{title:'处理时间',dataIndex:'createdAt',render:formatBeijingTime},
  ];
  const statistics:[string,string,string][]=[['待我审核','pendingMine',''],['范围内待审','pendingAll',''],['今日已审核','approvedToday','green'],['今日已驳回','rejectedToday','red'],['超时待审核','overdue','orange'],['本月已审核','approvedMonth','green']];
  const allocationOptions=detail?.allocationOptions||data.allocationOptions||[];
  const warehouseOptions=(type:string)=>Array.from(new Map(allocationOptions.filter((row:any)=>row.warehouseType===type).map((row:any)=>[row.warehouseId,{value:row.warehouseId,label:`${row.warehouseCode} ${row.warehouseName}`}])).values());
  const locationOptions=(warehouseId:string,itemId:string)=>{
    const inventory=capacityByKey[`${warehouseId}:${itemId}:INBOUND`];
    if(inventory)return (inventory.locations||[]).map((row:any)=>({value:row.locationId,disabled:row.isFull,label:`${locationDisplayName(row)}｜现存 ${formatQuantity(row.onHandQty)}｜${row.capacityQty===null?'不限量':`剩余 ${formatQuantity(row.availableCapacityQty)}`}`}));
    return allocationOptions.filter((row:any)=>row.warehouseId===warehouseId).map((row:any)=>({value:row.locationId,label:locationDisplayName(row)}));
  };

  return <div className="approvals-page">
    <div className="page-heading"><div><Typography.Title level={2}>审核中心</Typography.Title><Typography.Text type="secondary">所有库存审核与不良品处置统一在此处理。</Typography.Text></div><Button icon={<ReloadOutlined/>} onClick={load}>刷新</Button></div>
    <Space wrap style={{marginBottom:16}}><Button type={mode==='approval'?'primary':'default'} onClick={()=>{setMode('approval');setFilters({});}}>单据审核</Button>{canViewDefective&&<><Button type={mode==='defective'?'primary':'default'} onClick={()=>{setMode('defective');setFilters({});}}>待处理不良品</Button><Button type={mode==='records'?'primary':'default'} onClick={()=>{setMode('records');setFilters({});}}>不良品处理记录</Button></>}</Space>
    {mode==='approval'&&<Row gutter={[12,12]} className="approval-stats">{statistics.map(([title,key,color])=><Col xs={12} sm={8} lg={4} key={key}><Card hoverable onClick={()=>setTab(key==='pendingMine'?'pendingMine':key==='pendingAll'||key==='overdue'?'pendingAll':key==='approvedToday'||key==='approvedMonth'?'approved':'rejected')}><Statistic title={title} value={Number(stats[key]||0)} valueStyle={{color:color||undefined}}/></Card></Col>)}</Row>}
    <Card className="approval-workbench" title={<Space><SafetyCertificateOutlined/>{mode==='approval'?'审核工作台':mode==='defective'?'不良品处理工作台':'不良品处理记录'}</Space>} extra={mode==='approval'&&canReject&&selected.length?<Button danger icon={<CloseOutlined/>} onClick={()=>setRejecting('batch')}>批量驳回 ({selected.length})</Button>:null}>
      {mode==='approval'&&<div className="approval-tabs">{approvalTabs.map(([key,label])=><Button key={key} type={tab===key?'primary':'text'} onClick={()=>setTab(key)}>{label}</Button>)}</div>}
      <Space wrap className="approval-filters"><Input placeholder={mode==='approval'?'单号 / 物料':'物料 / 来源单据'} allowClear onChange={event=>setFilters((value:any)=>({...value,keyword:event.target.value}))}/>{mode!=='approval'&&<Select allowClear placeholder="物料类型" options={[{value:'MATERIAL',label:'原材料'},{value:'FINISHED_GOOD',label:'成品'}]} onChange={value=>setFilters((current:any)=>({...current,itemType:value}))}/>}<Button onClick={()=>setFilters({})}>重置</Button></Space>
      <Table rowKey="id" loading={loading} columns={mode==='approval'?approvalColumns:mode==='defective'?defectiveColumns:recordColumns} dataSource={data.items||[]} scroll={{x:1000}} pagination={{total:data.total||0,pageSize:mode==='approval'?20:50}} rowSelection={mode==='approval'&&canReject?{selectedRowKeys:selected,onChange:value=>setSelected(value as string[]),getCheckboxProps:(row:any)=>({disabled:row.status!=='SUBMITTED'})}:undefined}/>
    </Card>

    <Drawer title={`审核详情 - ${safe(detail?.documentNo,'未生成单号')}`} width={mobile?'100%':900} open={drawer} onClose={()=>setDrawer(false)} footer={<Space style={{display:'flex',justifyContent:'flex-end'}}><Button onClick={()=>setDrawer(false)}>关闭</Button>{detail?.status==='SUBMITTED'&&canReject&&<Button danger onClick={()=>setRejecting('single')}>驳回</Button>}{detail?.status==='SUBMITTED'&&canApprove&&<Button type="primary" icon={<CheckOutlined/>} onClick={approve}>审核通过</Button>}</Space>}>
      {detail&&<><Descriptions column={mobile?1:2} bordered size="small" items={[{label:'业务类型',children:docName(detail.documentType)},{label:'状态',children:statusText[detail.status]||detail.status},{label:'送审意向仓库',children:`${safe(detail.warehouseCode)} ${safe(detail.warehouseName,'')}`},{label:'提交时间',children:formatBeijingTime(detail.submittedAt)},{label:'来源业务',children:safe(detail.sourceDocumentNo)},{label:'备注',children:safe(detail.notes)}]}/>{detail.documentType==='STOCK_CHECK'&&<div className="warehouse-stock-check-summary"><Tag color="blue">物料种类 {stockCheckSummary.items.size}</Tag><Tag color="green">一致 {stockCheckSummary.consistent.size}</Tag><Tag color={stockCheckSummary.different.size?'orange':'default'}>存在差异 {stockCheckSummary.different.size}</Tag><Tag color="blue">盘盈 {stockCheckSummary.surplus.size}</Tag><Tag color="orange">盘亏 {stockCheckSummary.loss.size}</Tag><Checkbox checked={onlyCheckDifferences} onChange={event=>setOnlyCheckDifferences(event.target.checked)}>仅看差异</Checkbox></div>}<Table size="small" rowKey="id" pagination={false} dataSource={detail.documentType==='STOCK_CHECK'?visibleStockCheckLines:(detail.lines||[])} columns={detail.documentType==='STOCK_CHECK'?stockCheckColumns:[{title:'物料',render:(_:any,row:any)=>`${row.itemCode} ${row.itemName}`},{title:'原库位',render:(_:any,row:any)=><LocationName location={row}/>},{title:'批次',dataIndex:'batchNo',render:safe},{title:'数量',render:(_:any,row:any)=>`${formatQuantity(row.quantity)} ${row.unit}`}]} style={{marginTop:16}}/>{detail.receiptAllocations?.length>0&&<Table size="small" rowKey={(row:any)=>`${row.documentLineId}-${row.disposition}-${row.locationId}`} pagination={false} dataSource={detail.receiptAllocations} columns={[{title:'分配',dataIndex:'disposition',render:(value:string)=>value==='NORMAL'?'正常品':'不良品'},{title:'仓库',dataIndex:'warehouseCode'},{title:'库位',render:(_:any,row:any)=><LocationName location={row}/>},{title:'数量',dataIndex:'quantity',render:formatQuantity},{title:'不良原因',dataIndex:'defectReason',render:safe}]} style={{marginTop:16}}/>}</>}
    </Drawer>

    <Modal width={850} title="入库审核分配" open={allocationOpen} onCancel={()=>setAllocationOpen(false)} onOk={()=>allocationForm.submit()} okText="审核通过并过账">
      <Typography.Paragraph type="secondary">每条明细可全部正常入库或按整数数量拆分；不良品必须填写原因。</Typography.Paragraph>
      <Form form={allocationForm} layout="vertical" onFinish={saveAllocations}><Form.List name="allocations">{fields=><Space direction="vertical" style={{width:'100%'}}>{fields.map((field,index)=>{
        const line=detail?.lines?.[index]||{};const normalType=line.itemType==='MATERIAL'?'RAW':'FG';
        return <Card key={field.key} size="small" title={`${line.itemCode} ${line.itemName} · 送审 ${formatQuantity(line.quantity)} ${line.unit||''}`}>
          <Form.Item name={[field.name,'documentLineId']} hidden><Input/></Form.Item>
          <Button size="small" onClick={()=>allocationForm.setFieldValue(['allocations',field.name],{...allocationForm.getFieldValue(['allocations',field.name]),normalQty:Number(line.quantity),defectiveQty:0,defectReason:undefined})}>全部正常</Button>
          <Row gutter={12} style={{marginTop:8}}>
            <Col xs={24} md={8}><Form.Item label="正常数量" name={[field.name,'normalQty']} rules={[{required:true}]}><InputNumber min={0} precision={0} style={{width:'100%'}}/></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item label="正常仓库" name={[field.name,'normalWarehouseId']}><Select options={warehouseOptions(normalType)} onChange={()=>allocationForm.setFieldValue(['allocations',field.name,'normalLocationId'],undefined)}/></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item noStyle shouldUpdate>{({getFieldValue})=><Form.Item label="正常库位" name={[field.name,'normalLocationId']}><Select options={locationOptions(getFieldValue(['allocations',field.name,'normalWarehouseId']),line.itemId)}/></Form.Item>}</Form.Item></Col>
            <Col xs={24} md={8}><Form.Item label="不良数量" name={[field.name,'defectiveQty']} rules={[{required:true}]}><InputNumber min={0} precision={0} style={{width:'100%'}}/></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item label="不良品仓库" name={[field.name,'defectiveWarehouseId']}><Select allowClear options={warehouseOptions('DEFECTIVE')} onChange={()=>allocationForm.setFieldValue(['allocations',field.name,'defectiveLocationId'],undefined)}/></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item noStyle shouldUpdate>{({getFieldValue})=><Form.Item label="不良品库位" name={[field.name,'defectiveLocationId']}><Select allowClear options={locationOptions(getFieldValue(['allocations',field.name,'defectiveWarehouseId']),line.itemId)}/></Form.Item>}</Form.Item></Col>
            <Col span={24}><Form.Item label="不良原因" name={[field.name,'defectReason']}><Input.TextArea maxLength={500} rows={2}/></Form.Item></Col>
          </Row>
        </Card>;
      })}</Space>}</Form.List></Form>
    </Modal>

    <Modal title="处理不良品" open={Boolean(processing)} onCancel={()=>setProcessing(undefined)} onOk={()=>processForm.submit()} okText="确认处理">
      {processing&&<Form form={processForm} layout="vertical" onFinish={process}>
        <Descriptions size="small" column={1} items={[{label:'物料',children:`${processing.itemCode} ${processing.itemName}`},{label:'可处理数量',children:`${formatQuantity(processing.remainingQty)} ${processing.unit}`},{label:'不良原因',children:processing.defectReason}]}/>
        <Form.Item label="处理方式" name="action" rules={[{required:true}]}><Select options={processing.itemType==='MATERIAL'?[{value:'RETURN',label:'退货'},{value:'REPAIR_RESTOCK',label:'维修重新入库'}]:[{value:'RETURN_PRODUCTION',label:'退回生产任务'}]}/></Form.Item>
        <Form.Item label="处理数量" name="quantity" rules={[{required:true}]}><InputNumber min={1} max={Number(processing.remainingQty)} precision={0} style={{width:'100%'}}/></Form.Item>
        <Form.Item noStyle shouldUpdate>{({getFieldValue})=>getFieldValue('action')==='REPAIR_RESTOCK'?<><Form.Item label="目标原材料仓库" name="targetWarehouseId" rules={[{required:true}]}><Select options={warehouseOptions('RAW')} onChange={()=>processForm.setFieldValue('targetLocationId',undefined)}/></Form.Item><Form.Item label="目标库位" name="targetLocationId" rules={[{required:true}]}><Select options={locationOptions(getFieldValue('targetWarehouseId'),processing.itemId)}/></Form.Item></>:null}</Form.Item>
        {processing.itemType==='FINISHED_GOOD'&&<Form.Item label="生产任务" name="productionOrderId" rules={[{required:true}]}><Select disabled={Boolean(processing.productionOrderId)} options={(data.productionOrders||[]).filter((row:any)=>row.itemId===processing.itemId&&Number(row.availableCompletionQty)>=Number(processForm.getFieldValue('quantity')||1)).map((row:any)=>({value:row.id,label:`${row.orderNo}（待完工 ${formatQuantity(row.availableCompletionQty)}）`}))}/></Form.Item>}
        <Form.Item label={processing.itemType==='MATERIAL'?'处理原因 / 维修说明':'处理意见'} name="reason" rules={[{required:true},{max:500}]}><Input.TextArea rows={4} maxLength={500}/></Form.Item>
      </Form>}
    </Modal>

    <Modal title={rejecting==='batch'?'批量驳回':'驳回单据'} open={Boolean(rejecting)} onCancel={()=>setRejecting(undefined)} onOk={()=>rejectForm.submit()} okText="确认驳回" okButtonProps={{danger:true}}><Form form={rejectForm} layout="vertical" onFinish={reject}><Form.Item name="reasonCode" label="常用原因"><Select allowClear options={rejectReasons.map(value=>({value,label:value}))}/></Form.Item><Form.Item name="reason" label="驳回原因" rules={[{required:true},{max:500}]}><Input.TextArea rows={4} maxLength={500}/></Form.Item></Form></Modal>
  </div>;
}
