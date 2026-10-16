import { createDataSource } from './data-source';

/**
 * 按用户提供的编码清单批量补录原材料档案。
 * 规则：
 * - 清单内重复编码只插入一次；
 * - items 表中已存在的编码跳过（不覆盖名称/规格）；
 * - 名称暂用「物料-{编码}」占位，remark 标记为批量补录，业务方可后续在档案里改名称。
 * 执行：pnpm ts-node -r tsconfig-paths/register src/database/seed-item-codes-from-list.ts
 */
const RAW_CODES = `
10070029
10070017
10070030
10070031
10070032
10070033
1103019
10070034
10050041
10070035
10070036
10070037
10070038
10070039
10070018
10070041
90041
10070041
10070042
10070043
10070044
10070045
90028
100800011
100800012
100800013
100800014
1102012
10070047
10050044
10050036
10070046
10070011
90045
10070048
10070024
10070023
10070001
10070049
100800015
1103016
10070050
10070051
90054
90055
90056
90021
10070010
10070009
10070052
10070054
10070055
10070012
1103022
101000007
101000008
101000005
101000006
101000004
101000004
101000002
10070013
10070056
10070057
10070058
10070059
10070060
10070061
10070066
10070063
10070063
10070064
10070065
10070067
10070068
10070069
10070070
10070071
10070072
10070073
10070074
10070075
10070076
10070077
10070078
10070079
10070080
10070081
10070082
10070083
10070084
10070085
10070086
10070087
10070088
10070089
10070090
10070091
10070092
10070093
10070094
10070095
10070096
10070097
10070098
10070099
10070100
10070101
10070102
10070103
10070104
10070105
10070106
10070107
10070108
10070109
10070110
10070095
10070100
10070114
10070027
10070028
1006004
1006005
1006006
10050041
10050042
1001010
1001012
1001016
1001015
1001017
1001009
1001014
T20109
T20501
T20402
T20908
T20907
T30305
T20101
T10203
1003001
90049
402015
402014
90049
H20606
H20610
402013
1001035
1001045
1001037
10050047
1001044
10070013
10070021
10070048
10070015
101100004
90039
100800007
100800008
100800016
10050039
1001029
10070117
10070118
10070059
10070092
90026
10070001
10070120
10070119
10070121
10070003
100800018
100800007
10050048
1001008
1001046
10070122
10070123
10070068
100800019
100800014
10050040
10050006
10070117
10070125
10070052
10070092
10070001
10070092
1001039
10070046
`;

const REMARK = '批量补录物料，名称待业务确认';

async function run() {
  // 清单去重（保留首次出现顺序），同时统计重复次数
  const seen = new Set<string>();
  const codes: string[] = [];
  let duplicateCount = 0;
  for (const raw of RAW_CODES.split(/\r?\n/)) {
    const code = raw.trim();
    if (!code) continue;
    if (seen.has(code)) { duplicateCount += 1; continue; }
    seen.add(code);
    codes.push(code);
  }

  const db = createDataSource();
  await db.initialize();
  const runner = db.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    // items.unit_id NOT NULL，取单位档案中的真实单位
    const [unit] = await runner.query(`SELECT id,name FROM units WHERE status='ACTIVE' ORDER BY created_at LIMIT 1`);
    if (!unit) throw new Error('单位档案（units）中没有启用的单位，请先在系统中维护单位');

    // 已存在的编码（含已停用/已归档）一律跳过，不覆盖业务数据
    const existingRows: Array<{ item_code: string }> = await runner.query(
      `SELECT item_code FROM items WHERE item_code=ANY($1::varchar[])`,
      [codes],
    );
    const existing = new Set(existingRows.map(row => row.item_code));
    const toInsert = codes.filter(code => !existing.has(code));

    for (const code of toInsert) {
      await runner.query(
        `INSERT INTO items(item_code,name,item_type,unit,unit_id,minimum_stock,status,enable_batch,remark)
         VALUES($1,$2,'MATERIAL',$3,$4,0,'ACTIVE',false,$5)`,
        [code, `物料-${code}`, unit.name, unit.id, REMARK],
      );
    }

    await runner.commitTransaction();
    console.log(`清单总行数（含重复）：${codes.length + duplicateCount}`);
    console.log(`去重后编码数：${codes.length}，其中重复 ${duplicateCount} 行已合并`);
    console.log(`已存在跳过：${existing.size} 个${existing.size ? `（${[...existing].join('、')}）` : ''}`);
    console.log(`本次新增：${toInsert.length} 个${toInsert.length ? `（${toInsert.join('、')}）` : ''}`);
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
    await db.destroy();
  }
}

if (require.main === module) run().catch((error) => { console.error(error); process.exit(1); });
