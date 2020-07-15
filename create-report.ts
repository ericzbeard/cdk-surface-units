import * as reflect from 'jsii-reflect';
import * as fs from 'fs';
import * as path from 'path';
import * as mysql from 'mysql';
import { promisify } from 'util';

/**
 * Get an environment variable or throw an error if it is not set, unless the 
 * missing parameter is provided, in which case that string is returned.
 */
export const getEnv = (name: string, missing?: string): string => {
  let env = process.env[name];
  if (!env && missing === undefined) {
    throw Error(`${name} environment variable not set`);
  }
  if (!env) {
    env = missing;
  }
  return env || '';
}

async function main(persist: string) {
  const ts = new reflect.TypeSystem();

  let mysqlConfigured = false;
  let restApiConfigured = false;
  let connection:any;
  let restApiUrl: string;

  // Connect to the local database
  if (persist === "mysql") {
    require('dotenv').config();

    var mysql = require('mysql');
    connection = mysql.createConnection({
      host: getEnv('CDK_PM_HOST'),
      user: getEnv('CDK_PM_USER'),
      password: getEnv('CDK_PM_PASSWORD'),
      database: getEnv('CDK_PM_DATABASE'),
      insecureAuth: true
    });

    connection.connect();

    mysqlConfigured = true;

    console.log("Connected to MySQL");
  }

  // Submit modules to the rest api
  if (persist === "rest") {
    restApiUrl = getEnv('REST_API_URL');
    restApiConfigured = true;
  }

  // load all .jsii files into the type system
  for (const file of fs.readdirSync('./jsii')) {
    const filePath = path.join('./jsii', file);
    upgradeManifest(filePath);
    await ts.load(filePath);
  }

  const resourceCsv = fs.createWriteStream('resources.csv');
  const modulesCsv = fs.createWriteStream('modules.csv');

  resourceCsv.write(`service,resource,surface,stability\n`);
  modulesCsv.write(`Service,Stability,Surface (props),Stable (props),Experimental (props),Deprecated (props),Coverage,Total SUs,Covered SUs\n`);

  // ready to explore!
  for (const a of ts.assemblies) {
    if (!a.name.startsWith('@aws-cdk/aws-')) { continue; }
    const comps = a.name.split('-');
    if (comps.length !== 3) { continue; } // e.g. aws-s3-deployment
    const service = comps[2];

    let total = 0;
    let totalCfn = 0;
    let totalStable = 0;
    let totalExperimental = 0;
    let totalDeprecated = 0;
    let moduleStability = 'cfn-only';
    let maturityPk = 1;
    let stabilityPk = 1;

    for (const cfn of a.classes) {
      if (!cfn.name.startsWith('Cfn')) { continue; }

      const props = getPropsType(cfn);
      const propCount = !props ? 0 : countProps(props);
      const l2 = findL2(cfn);

      const baseName = cfn.name.substr(3);
      let stability = 'cfn-only';
      if (l2) {
        stability = l2.docs.stability as string;
      }

      total += propCount;

      if (stability === 'cfn-only') {
        totalCfn += propCount;
      } else if (stability === 'experimental' || stability == null) {
        totalExperimental += propCount;
        moduleStability = 'experimental';
        maturityPk = 2;
        stabilityPk = 1;
      } else if (stability === 'stable') {
        totalStable += propCount;
        moduleStability = 'stable';
        maturityPk = 4;
        stabilityPk = 2;
      } else if (stability === 'deprecated') {
        totalDeprecated += propCount;
        moduleStability = 'deprecated';
        maturityPk = 5;
        stabilityPk = 3;
      } else {
        throw new Error(`unexpected stability ${stability}`);
      }

      resourceCsv.write(`${service},${baseName},${propCount},${stability}\n`);
    }

    const coverage = Math.round((totalStable + totalExperimental) / total * 100);
    const totalSU = Math.ceil(total / 10);
    const coveredSU = totalSU * coverage / 100;

    modulesCsv.write(`${service},${moduleStability},${total},${totalStable},${totalExperimental},${totalDeprecated},${coverage}%,${totalSU},${coveredSU}\n`);

    if (mysqlConfigured) {
      // Local aws_cdk_pm MySQL database
      // Call module_save and module_history_save

      const m: any = {};
      m.module = service;
      m.tier = 1;
      m.stability = stabilityPk;
      m.maturity = maturityPk;
      m.category = 1;
      m.cdk_stacks = 0;
      m.cfn_stacks = 0;
      m.tracking_issue_url = '';
      m.num_props = total;
      m.num_stable_props = totalStable;
      m.num_deprecated_props = totalDeprecated;
      m.num_experimental_props = totalExperimental;

      let query = promisify(connection.query).bind(connection);
      await query('call module_save(?,?,?,?,?,?,?,?,?,?,?,?)', [
        m.module,  // p_module
        m.tier,  // p_tier
        m.stability,  // p_stability
        m.maturity,  // p_maturity
        m.category,  // p_category
        m.cdk_stacks,  // p_cdk_stacks
        m.cfn_stacks,  // p_cfn_stacks
        m.tracking_issue_url,  // p_tracking_issue_url
        m.num_props,  // p_num_props
        m.num_stable_props,  // p_num_stable_props
        m.num_deprecated_props,  // p_num_deprecated_props
        m.num_experimental_props  // p_num_experimental_props
      ]);

      console.log("Saved " + m.module);

    } else if (restApiConfigured) {
      // Remote aws_cdk_pm REST API
      // POST module
      // TODO
    }

  }

  connection.end();

}

function findL2(cfnClass: reflect.ClassType) {
  const asm = cfnClass.assembly;
  const expectedName = cfnClass.name.substr(3); // strip "Cfn"
  const found = asm.tryFindType(`${asm.name}.${expectedName}`);
  if (found) {
    return found;
  }

  // not found based on expected name, look for the "@resource" annotation
  for (const cls of cfnClass.assembly.classes) {
    const resource = cls.docs.customTag('resource');
    if (resource) {
      const baseName = resource.split('::')[2];
      if (baseName.toLocaleLowerCase() === expectedName.toLocaleLowerCase()) {
        return cls;
      }
    }
  }

  return undefined;
}

function getPropsType(constructType: reflect.ClassType) {
  if (constructType.initializer!.parameters.length < 3) {
    return undefined;
  }
  const props = constructType.initializer!.parameters[2];
  if (props.name !== 'props') {
    throw new Error(`invalid 3rd parameter name. expecting "props" got ${props.name}`);
  }

  return constructType.system.findInterface(props.type.fqn!)
}

function countProps(struct: reflect.InterfaceType) {
  let count = 0;
  for (const field of struct.allProperties) {
    count++;
    if (field.type.fqn) {
      count += countProps(struct.system.findInterface(field.type.fqn));
    }
  }

  return count;
}

function upgradeManifest(filePath: string) {
  const manifest = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  for (const [key, value] of Object.entries(manifest.dependencies || {})) {
    const newValue = typeof (value) === 'object' ? (value as any).version : value;
    manifest.dependencies[key] = newValue;
  }

  fs.writeFileSync(filePath, JSON.stringify(manifest, undefined, 2));
}

const args = process.argv.slice(2);
main(args[0]).catch(e => {
  console.error(e);
  process.exit(1);
});