import * as reflect from 'jsii-reflect';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const ts = new reflect.TypeSystem();

  // load all .jsii files into the type system
  for (const file of fs.readdirSync('./jsii')) {
    const filePath = path.join('./jsii', file);
    upgradeManifest(filePath);
    await ts.load(filePath);
  }

  const resourceCsv = fs.createWriteStream('resources.csv');
  const modulesCsv = fs.createWriteStream('modules.csv');

  resourceCsv.write(`service,resource,surface,stability\n`);
  modulesCsv.write(`Service,Stability,Surface (props),Stable (props),Experimental (props),Coverage,Total SUs,Covered SUs\n`);

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
    let moduleStability = 'cfn-only';

    for (const cfn of a.classes) {
      if (!cfn.name.startsWith('Cfn')) { continue; }

      const props = getPropsType(cfn);
      const propCount = !props ? 0 : countProps(props);
      const l2 = findL2(cfn);

      const baseName = cfn.name.substr(3);
      let stability = 'cfn-only';
      if (l2) {
        stability = l2.docs.stability;
      }

      total += propCount;

      if (stability === 'cfn-only') {
        totalCfn += propCount;
      } else if (stability === 'experimental' || stability == null) {
        totalExperimental += propCount;
        moduleStability = 'experimental';
      } else if (stability === 'stable') {
        totalStable += propCount;
        moduleStability = 'stable';
      } else {
        throw new Error(`unexpected stability ${stability}`);
      }

      resourceCsv.write(`${service},${baseName},${propCount},${stability}\n`);
    }

    const coverage = Math.round((totalStable + totalExperimental) / total * 100);
    const totalSU = Math.ceil(total / 10);
    const coveredSU = totalSU * coverage / 100;

    modulesCsv.write(`${service},${moduleStability},${total},${totalStable},${totalExperimental},${coverage}%,${totalSU},${coveredSU}\n`);
  }
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
  if (constructType.initializer.parameters.length < 3) {
    return undefined;
  }
  const props = constructType.initializer.parameters[2];
  if (props.name !== 'props') {
    throw new Error(`invalid 3rd parameter name. expecting "props" got ${props.name}`);
  }

  return constructType.system.findInterface(props.type.fqn)
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
  for (const [key,value] of Object.entries(manifest.dependencies || {})) {
    const newValue = typeof(value) === 'object' ? (value as any).version : value;
    manifest.dependencies[key] = newValue;
  }

  fs.writeFileSync(filePath, JSON.stringify(manifest, undefined, 2));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});