/*jshint esversion: 6 */
const Config = require('./config.json');
const fs = require('fs');
const crypto = require('crypto');
const request = require('request');
const https = require('https');
const url = require('url');

const Docker = require('dockerode');
const docker = new Docker();
const db = require('./include/container-manager-db.js');

const databoxNet = require('./lib/databox-network-helper.js')(docker);

//ARCH to append -arm to the end of a container name if running on arm
//swarm mode dose not use this for now
let ARCH = '';
//if (process.arch == 'arm') {
//	ARCH = '-arm';
//}

const arbiterKey = fs.readFileSync("/run/secrets/CM_KEY", {encoding: 'base64'});

const DATABOX_ARBITER_ENDPOINT = "https://arbiter:8080";
const DATABOX_EXPORT_SERVICE_ENDPOINT = "https://export-service:8080";

//setup dev env
const DATABOX_DEV = process.env.DATABOX_DEV;

//Get the current running version
let DATABOX_VERSION = process.env.DATABOX_VERSION;


let getRegistryUrlFromSLA = function (sla) {
	//default to the config file
	let registryUrl = Config.registryUrl;

	if (sla.storeUrl) {
		const storeUrl = url.parse(sla.storeUrl);
		if (storeUrl.hostname === "localhost" || storeUrl.hostname === "127.0.0.1") {
			//its a locally installed image get it from the local system
			console.log("Using local registry");
			registryUrl = "";
		} else {
			if (sla.registry) {
				//allow overriding image location in manifest for SDK
				registryUrl = sla.registry + "/";
			} else {
				//default to databox systems
				console.log("Using tshdataboxsystems2 registry");
				registryUrl = "tshdataboxsystems2/";
			}
		}
	}
	console.log("SETTING REG TO ::", registryUrl);
	return registryUrl;
};


let arbiterAgent; //An https agent that will not reject certs signed by the CM
let httpsHelper;
exports.setHttpsHelper = function (helper) {
	httpsHelper = helper;
	arbiterAgent = new https.Agent({
		ca: fs.readFileSync("/run/secrets/DATABOX_ROOT_CA")
	});
};

//
// Generate ZMQ keys
// { public: 'SOME_PUB_KEY', secret: 'SOME_PRIVATE_KEY' }
//
// pub key goes to apps
// privet key is shared with stores
//
// TODO: All instances of core-store share keys this is not ideal!
const zmq = require('zeromq')
const zmq_keys = zmq.zmqCurveKeypair();

docker.getSecret('databox_ZMQ_SECRET_KEY').inspect().then((key) => {
	console.log("ZMQ_SECRET_KEY exists doing nothing!!", key);
})
.catch(()=>{
	console.log("ZMQ_SECRET_KEY not yet created making it!!")
	//write the /run/secrets/ZMQ_PUBLIC_KEY for uses in the CM
	if (!fs.existsSync('/run/secrets/')) fs.mkdirSync('/run/secrets/');
	try {
		fs.writeFileSync('/run/secrets/ZMQ_PUBLIC_KEY',Buffer.from(zmq_keys.public));
	} catch (err) {
		console.log("Error witting ZMQ_PUBLIC_KEY:", err);
	}

	docker.createSecret({
		"Name": "databox_ZMQ_PUBLIC_KEY",
		"Data": Buffer.from(zmq_keys.public).toString('base64')
	})
	.catch((err) => {
		console.log('[ERROR] creating secret databox_ZMQ_PUBLIC_KEY', err)
	})

	docker.createSecret({
		"Name": "databox_ZMQ_SECRET_KEY",
		"Data": Buffer.from(zmq_keys.secret).toString('base64')
	})
	.catch((err) => {
		console.log('[ERROR] creating secret databox_ZMQ_SECRET_KEY', err)
	})
})



const install = async function (sla) {
	return new Promise(async (resolve, reject) => {

		let name = repoTagToName(sla.name) + ARCH;

		//set the local name of the container. Containers launched as dependencies
		//have their local name set to [rootContainerName]-[dependentContainerName]
		if (!("localContainerName" in sla)) {
			sla.localContainerName = name;
		}

		//make sure the sla['resource-requirements']['store'] is an array
		if (sla['resource-requirements'] && sla['resource-requirements']['store']) {
			if (!Array.isArray(sla['resource-requirements']['store'])) {
				sla['resource-requirements']['store'] = [sla['resource-requirements']['store']]
			}
		}

		console.log('[' + name + '] Launching');

		//let config = loadGlobalDockerConfig();
		let containerConfig = {
			"Name": "",
			"Labels": {},
			"TaskTemplate": {
				"ContainerSpec": {
					"Image": ""
				},
				"Resources": {
					"Limits": {},
					"Reservations": {}
				},
				"RestartPolicy": {},
				"Placement": {}
			},
			"Mode": {
				"Replicated": {
					"Replicas": 1
				}
			},
			"UpdateConfig": {
				"Parallelism": 1
			},
			"EndpointSpec": {
				"Mode": "dnsrr"
			},
			"Networks": []
		};

		//Get a deep copy! why is this so difficult !!!
		let dependentStoreConfigTemplate = JSON.parse(JSON.stringify(containerConfig));
		let dependentStoreConfigArray;

		let networkConfig = await databoxNet.preConfig(sla);
		console.log("preconfig: ", networkConfig);

		switch (sla['databox-type']) {
			case 'app':
				containerConfig = appConfig(containerConfig, sla, networkConfig);
				containerConfig = await createSecrets(containerConfig, sla);
				dependentStoreConfigArray = storeConfig(dependentStoreConfigTemplate, sla, networkConfig);
				break;
			case 'driver':
				containerConfig = driverConfig(containerConfig, sla, networkConfig);
				containerConfig = await createSecrets(containerConfig, sla);
				dependentStoreConfigArray = storeConfig(dependentStoreConfigTemplate, sla, networkConfig);
				break;
			default:
				reject('Missing or unsupported databox-type in SLA');
				return;
		}

		saveSLA(sla);

		//RELAY ON config.TaskTemplate.ContainerSpec.Env to find out communication peers
		await databoxNet.connectEndpoints(containerConfig, dependentStoreConfigArray, sla);

		//UPDATE SERVICES
		if (dependentStoreConfigArray !== false) {
			for (let dependentStoreConfig of dependentStoreConfigArray) {
				console.log("[CM] creating dependent store service " + dependentStoreConfig.Name);
				dependentStoreConfig = await createSecrets(dependentStoreConfig, {
					"localContainerName": dependentStoreConfig.Name,
					"databox-type": "store"
				});
				await docker.createService(dependentStoreConfig)
					.catch((err) => {
						console.log("[ERROR] creating dependent store service ", dependentStoreConfig, err)
					});
			}

			//Give the stores a bit of time to startup
			function wait () { return new Promise( (resolve,reject)=>{ setTimeout(resolve,5000)} )};
			await wait();
		}
		console.log("[CM] creating service " + containerConfig.Name);
		await docker.createService(containerConfig)
			.catch((err) => {
				console.log("[ERROR] creating service ", containerConfig, err)
			});

		//Add all the permissions for App/driver and any dependent store
		await addPermissionsFromSla(sla)
			.catch((err) => {
				reject("Error adding permissions" + err);
			});

		resolve([containerConfig.Name, containerConfig.Name || "NO STORE"]);
	});
};
exports.install = install;

const uninstall = async function (name) {
	let networkConfig = await databoxNet.networkOfService(name);
	return docker.getService(name).remove()
		.then(() => docker.listSecrets({filters: {'label': ['databox.service.name=' + name]}}))
		.then((secrets) => {
			const proms = [];
			for (const secret of secrets) {
				proms.push(docker.getSecret(secret.ID).remove())
			}

			return Promise.all(proms)
		})
		.then(() => databoxNet.postUninstall(name, networkConfig))
		.then(() => db.deleteSLA(name, false));
};
exports.uninstall = uninstall;

const restart = async function (name) {
	let old_ip;

	const _wait_restart = function(name, old_ip) {
		//console.log("[restart] wait " + name + " to restart");
		return docker.listContainers({
			all: true,
			filters: {"label": ["com.docker.swarm.service.name=" + name]}
		})
			.then((containers) => {
				if (containers.length !== 0) {
					let new_ip;

					for (const containerInfo of containers) {
						//console.log(JSON.stringify(containerInfo));
						for (var net_name in containerInfo.NetworkSettings.Networks) {
							let service_name = name.replace("-core-store", "").replace("-store-json", "");
							if (net_name.includes(service_name)) {
								new_ip = containerInfo.NetworkSettings.Networks[net_name].IPAMConfig.IPv4Address;
							}
						}
					}

					if (new_ip) {
						if (old_ip === new_ip) {
							console.log("[restart] IP of service " + name + " not changed");
						} else {
							console.log("[restart] IP of service " + name + ": " + old_ip + " -> " + new_ip);
							return databoxNet.serviceRestart(name, old_ip, new_ip);
						}
					} else {
						return setTimeout(() => _wait_restart(name, old_ip), 500);
					}
				} else {
					return setTimeout(() => _wait_restart(name, old_ip), 500);
				}
			});
	};

	return docker.listContainers({
		all: true,
		filters: {"label": ["com.docker.swarm.service.name=" + name]}
	})
		.then((containers) => {
			const proms = [];
			for (const containerInfo of containers) {
				//console.log(JSON.stringify(containerInfo));
				for (var net_name in containerInfo.NetworkSettings.Networks) {
					let service_name = name.replace("-core-store", "").replace("-store-json", "");
					if (net_name.includes(service_name)) {
						old_ip = containerInfo.NetworkSettings.Networks[net_name].IPAMConfig.IPv4Address;
					}
				}

				const container = docker.getContainer(containerInfo.Id);
				proms.push(container.remove({force: true}))
			}
			return Promise.all(proms);
		})
		.then(() => {
			return _wait_restart(name, old_ip);
		});
};
exports.restart = restart;

function removeSecret(name) {
	return docker.getSecret(name).remove()
		.catch((error) => console.log(error.message))
}

const createSecrets = async function (config, sla) {

	function addSecret(filename, name, id) {
		config.TaskTemplate.ContainerSpec.secrets.push({
			"SecretName": name, "SecretID": id, "File": {
				"Name": filename,
				"UID": "0",
				"GID": "0",
				"Mode": 292
			}
		});
	}

	async function createSecret(name, data, filename) {
		return docker.createSecret({
			"Name": name,
			"Labels": {
				'databox.service.name': sla.localContainerName
			},
			"Data": data
		})
		.then((secret) => {
			addSecret(filename, name, secret.id);
			return {"name": name, "id": secret.id};
		})
		.catch((err) => {
			console.log('[ERROR] creating secret ' + name, err)
		});
	}

	console.log("createSecrets");

	//HTTPS certs Json
	const certJson = await httpsHelper.createClientCert(sla.localContainerName);
	const parsedCert = JSON.parse(certJson);
	const pem = parsedCert.clientprivate + parsedCert.clientpublic + parsedCert.clientcert;

	const arbiterToken = await generateArbiterToken(sla.localContainerName);

	let proms = [
		docker.getSecret('databox_DATABOX_ROOT_CA').inspect().then((rootCA) => {
			addSecret("DATABOX_ROOT_CA", rootCA.Spec.Name, rootCA.ID)
		}),
		docker.getSecret('databox_ZMQ_PUBLIC_KEY').inspect().then((key) => {
			addSecret("ZMQ_PUBLIC_KEY", key.Spec.Name, key.ID)
		}),
		createSecret(sla.localContainerName.toUpperCase() + '_PEM', Buffer.from(certJson).toString('base64'), "DATABOX_PEM"),
		createSecret(sla.localContainerName.toUpperCase() + '.pem', Buffer.from(pem).toString('base64'), "DATABOX.pem"),
		createSecret(sla.localContainerName.toUpperCase() + '_KEY', arbiterToken, "ARBITER_TOKEN"),
		updateArbiter({name: sla.localContainerName, key: arbiterToken, type: sla['databox-type']})
	]

	if(sla['databox-type'] == 'store') {
		proms.push(docker.getSecret('databox_ZMQ_SECRET_KEY').inspect().then((key) => {
			addSecret("ZMQ_SECRET_KEY", key.Spec.Name, key.ID)
		}));
	}

	await Promise.all(proms);

	return config
};


function calculateImageVersion (registry) {

	if (DATABOX_DEV == 1) {
		//we are in dev mode try latest
		return ":latest";
	} else {
		//we are not in dev mode try versioned
		return ":" + DATABOX_VERSION;
	}

}


const driverConfig = function (config, sla, network) {

  console.log("addDriverConfig");

	let localContainerName = sla.name + ARCH;

	let registryUrl = getRegistryUrlFromSLA(sla);

	let version = calculateImageVersion(registryUrl);

	let driver = {
		image: registryUrl + localContainerName + version,
		Env: [
			"DATABOX_LOCAL_NAME=" + localContainerName,
			"DATABOX_ARBITER_ENDPOINT=" + DATABOX_ARBITER_ENDPOINT,
		],
		secrets: [],
		DNSConfig: {
			NameServers: [network.DNS]
		}
	};

	if (sla['resource-requirements'] && sla['resource-requirements']['store']) {

		if (sla['resource-requirements']['store'].length === 1) {
			//TODO remove this
			let storeName = sla.name + "-" + sla['resource-requirements']['store'] + ARCH;
			driver.Env.push("DATABOX_STORE_ENDPOINT=https://" + storeName + ":8080");
			driver.Env.push("DATABOX_ZMQ_ENDPOINT=tcp://" + storeName + ":5555");
			driver.Env.push("DATABOX_ZMQ_DEALER_ENDPOINT=tcp://" + storeName + ":5556");
		} else {
			for (storeType of sla['resource-requirements']['store']) {
				let storeName = sla.name + "-" + storeType + ARCH;
				if(storeType == 'core-store') {
					driver.Env.push("DATABOX_" + storeType.toUpperCase().replace('-', '_') + "_ENDPOINT=tcp://" + storeName + ":5555");
				} else {
					driver.Env.push("DATABOX_" + storeType.toUpperCase().replace('-', '_') + "_ENDPOINT=https://" + storeName + ":8080");
				}
			}
		}
	}


	//config.Networks.push({Target: 'databox_databox-driver-net'});
	config.Networks.push({Target: network.NetworkName});
	config.Name = localContainerName;
	config.Labels['databox.type'] = 'driver';
	config.TaskTemplate.ContainerSpec = driver;
	config.TaskTemplate.Placement.constraints = ["node.role == manager"];

	return config;
};

const appConfig = function (config, sla, network) {
	let localContainerName = sla.name + ARCH;

	let registryUrl = getRegistryUrlFromSLA(sla);

	let version = calculateImageVersion(registryUrl);

	let app = {
		image: registryUrl + localContainerName + version,
		Env: [
			"DATABOX_LOCAL_NAME=" + localContainerName,
			"DATABOX_ARBITER_ENDPOINT=" + DATABOX_ARBITER_ENDPOINT,
			"DATABOX_EXPORT_SERVICE_ENDPOINT=" + DATABOX_EXPORT_SERVICE_ENDPOINT
		],
		secrets: [],
		DNSConfig: {
			NameServers: [network.DNS]
		}
	};

	//packages are being removed.
	/*if ('packages' in sla) {
		console.log(sla.packages)
		for (let manifestPackage of sla.packages) {
			let packageEnabled = 'enabled' in manifestPackage ? manifestPackage.enabled : false;
			app.Env.push("PACKAGE_" + manifestPackage.id + "=" + packageEnabled);
		}
	}*/

	if ('datasources' in sla) {
		for (let datasource of sla.datasources) {
			app.Env.push("DATASOURCE_" + datasource.clientid + "=" + JSON.stringify(datasource.hypercat || {}));
		}
	}

	if (sla['resource-requirements'] && sla['resource-requirements']['store']) {

		if (sla['resource-requirements']['store'].length === 1) {
			//TODO remove this
			let storeName = sla.name + "-" + sla['resource-requirements']['store'] + ARCH;
			app.Env.push("DATABOX_STORE_ENDPOINT=https://" + storeName + ":8080");
			app.Env.push("DATABOX_ZMQ_ENDPOINT=tcp://" + storeName + ":5555");
			app.Env.push("DATABOX_ZMQ_DEALER_ENDPOINT=tcp://" + storeName + ":5556");
		} else {
			for (storeType of sla['resource-requirements']['store']) {
				let storeName = sla.name + "-" + storeType + ARCH;
				if(storeType == 'core-store') {
					driver.Env.push("DATABOX_" + storeType.toUpperCase().replace('-', '_') + "_ENDPOINT=tcp://" + storeName + ":5555");
				} else {
					driver.Env.push("DATABOX_" + storeType.toUpperCase().replace('-', '_') + "_ENDPOINT=https://" + storeName + ":8080");
				}
			}
		}
	}

	//config.Networks.push({Target: 'databox_databox-app-net'});
	config.Networks.push({Target: network.NetworkName});
	config.Name = localContainerName;
	config.TaskTemplate.ContainerSpec = app;
	config.TaskTemplate.Placement.constraints = ["node.role == manager"];
	config.Labels['databox.type'] = 'app';
	return config;
};

const storeConfig = function (configTemplate, sla, network) {
	console.log("addStoreConfig");

	if (!sla['resource-requirements'] || !sla['resource-requirements']['store']) {
		return false;
	}


	let stores = sla['resource-requirements']['store'];
	let configArray = [];
	for (let storeName of stores) {

		let config = JSON.parse(JSON.stringify(configTemplate));

		let rootContainerName = storeName;
		let requiredName = sla.name + "-" + storeName + ARCH;

		let registryUrl = getRegistryUrlFromSLA(sla);

		let version = calculateImageVersion(registryUrl);

		let store = {
			image: registryUrl + rootContainerName + version,
			Env: [
				"DATABOX_LOCAL_NAME=" + requiredName,
				"DATABOX_ARBITER_ENDPOINT=" + DATABOX_ARBITER_ENDPOINT,
			],
			secrets: [],
			DNSConfig: {
				NameServers: [network.DNS]
			}
		};

		//config.Networks.push({Target: 'databox_databox-driver-net'});
		//config.Networks.push({Target: 'databox_databox-app-net'});
		config.Networks.push({Target: network.NetworkName});

		let vol = "/database";
		store.Mounts = [{Source: requiredName, Target: vol, type: "volume"}];

		config.Name = requiredName;
		config.Labels['databox.type'] = 'store';
		config.TaskTemplate.ContainerSpec = store;
		config.TaskTemplate.Placement.constraints = ["node.role == manager"];

		configArray.push(config)
	}

	return configArray;
};

async function addPermissionsFromSla(sla) {

	console.log("addPermissionsFromSla");

	const localContainerName = sla.name + ARCH;
	const type = sla['databox-type'];
	const proms = [];

	//set export permissions from export-whitelist
	if (sla['export-whitelist'] && type === 'app') {

		let urlsString = sla['export-whitelist'].map((itm) => {
			return '"' + itm.url + '"';
		}).join(',');

		console.log("[Adding Export permissions for " + localContainerName + "] on " + urlsString);

		let targetName = url.parse(DATABOX_EXPORT_SERVICE_ENDPOINT).hostname;
		proms.push(updateContainerPermissions({
			name: localContainerName,
			route: {target: targetName, path: '/export/', method: 'POST'},
			caveats: ["destination = [" + urlsString + "]"]
		}));
		proms.push(updateContainerPermissions({
			name: localContainerName,
			route: {target: targetName, path: '/lp/export/', method: 'POST'},
			caveats: ["destination = [" + urlsString + "]"]
		}));
	}

	//set read permissions from the sla for DATASOURCES.
	if (sla.datasources && type === 'app') {
		for (let allowedDatasource of sla.datasources) {
			if (allowedDatasource.hypercat) {

				let datasourceEndpoint = url.parse(allowedDatasource.hypercat['href']);
				let datasourceName = datasourceEndpoint.path.replace('/', '');

				const isActuator = allowedDatasource.hypercat['item-metadata'].findIndex((itm) => {
					return (itm.rel === 'urn:X-databox:rels:isActuator') && (itm.val === true);
				});

				if (isActuator !== -1) {
					//its an actuator we need write access
					proms.push(updateContainerPermissions({
						name: localContainerName,
						route: {
							target: datasourceEndpoint.hostname,
							path: '/' + datasourceName + '/*',
							method: 'POST'
						}
					}));
					proms.push(updateContainerPermissions({
						name: localContainerName,
						route: {
							target: datasourceEndpoint.hostname,
							path: '/' + datasourceName,
							method: 'POST'
						}
					}));
				}

				proms.push(updateContainerPermissions({
					name: localContainerName,
					route: {target: datasourceEndpoint.hostname, path: '/status', method: 'GET'}
				}));

				proms.push(updateContainerPermissions({
					name: localContainerName,
					route: {
						target: datasourceEndpoint.hostname,
						path: '/' + datasourceName,
						method: 'GET'
					}
				}));

				proms.push(updateContainerPermissions({
					name: localContainerName,
					route: {
						target: datasourceEndpoint.hostname,
						path: '/' + datasourceName + '/*',
						method: 'GET'
					}
				}));

				proms.push(updateContainerPermissions({
					name: localContainerName,
					route: {target: datasourceEndpoint.hostname, path: '/ws', method: 'GET'}
				}));

				proms.push(updateContainerPermissions({
					name: localContainerName,
					route: {
						target: datasourceEndpoint.hostname,
						path: '/sub/' + datasourceName + '/*',
						method: 'GET'
					}
				}));
			}
		}
	}

	//Add permissions for dependent stores
	if (sla['resource-requirements'] && sla['resource-requirements']['store']) {

		for (const storeType of sla['resource-requirements']['store']) {
			const store = {
				name: sla.name + "-" + storeType + ARCH
			};

			//Read /cat for CM
			console.log('[Adding read permissions] for container-manager on ' + store.name + '/cat');
			proms.push(updateContainerPermissions({
				name: 'container-manager',
				route: {target: store.name, path: '/cat', method: 'GET'}
			}));

			//Read /status
			console.log('[Adding read permissions] for ' + localContainerName + ' on ' + store.name + '/status');
			proms.push(updateContainerPermissions({
				name: localContainerName,
				route: {target: store.name, path: '/status', method: 'GET'}
			}));

			//Read /ws
			console.log('[Adding read permissions] for ' + localContainerName + ' on ' + store.name + '/ws');
			proms.push(updateContainerPermissions({
				name: localContainerName,
				route: {target: store.name, path: '/ws', method: 'GET'}
			}));

			console.log('[Adding read permissions] for ' + localContainerName + ' on ' + store.name + '/sub/*');
			proms.push(updateContainerPermissions({
				name: localContainerName,
				route: {target: store.name, path: '/sub/*', method: 'GET'}
			}));

			console.log('[Adding read permissions] for ' + localContainerName + ' on ' + store.name + '/unsub/*');
			proms.push(updateContainerPermissions({
				name: localContainerName,
				route: {target: store.name, path: '/unsub/*', method: 'GET'}
			}));

			//Write to all endpoints on dependent store
			console.log('[Adding write permissions] for ' + localContainerName + ' on ' + store.name);
			proms.push(updateContainerPermissions({
				name: localContainerName,
				route: {target: store.name, path: '/*', method: 'POST'}
			}));

			//Read to all endpoints on dependent store (sometimes its nice to read what you have written)
			console.log('[Adding read permissions] for ' + localContainerName + ' on ' + store.name);
			proms.push(updateContainerPermissions({
				name: localContainerName,
				route: {target: store.name, path: '/*', method: 'GET'}
			}));

			//Write to /cat on dependent store
			console.log('[Adding write permissions] for ' + localContainerName + ' on ' + store.name + '/cat');
			proms.push(updateContainerPermissions({
				name: localContainerName,
				route: {target: store.name, path: '/cat', method: 'POST'}
			}));

		}

	}

	return Promise.all(proms);
}


exports.connect = function () {
	return new Promise((resolve, reject) => docker.ping(function (err, data) {
			if (err) {
				reject("Cant connect to docker!");
				return;
			}
			resolve();
		}))
		.then(() => databoxNet.identifySelf())
		.then(() => databoxNet.identifyCM());
};

exports.listServices = function (type) {
	if (type) {
		return docker.listServices({all: true, filters: {"label": ["databox.type=" + type]}});
	}
	return docker.listServices({all: true, filters: {"label": ["databox.type"]}});
};

exports.listTasks = function (service) {
	return docker.listTasks({all: true, filters: {"service": [service]}});
};

exports.listContainers = function () {
	return docker.listContainers({all: true, filters: {"label": ["databox.type"]}});
};

const repoTagToName = function (repoTag) {
	return repoTag.match(/(?:.*\/)?([^/:\s]+)(?::.*|$)/)[1];
};

async function generateArbiterToken(name) {
	return new Promise((resolve, reject) => {
		crypto.randomBytes(32, function (err, buffer) {
			if (err) reject(err);
			const token = buffer.toString('base64');
			resolve(token);
		});
	});
}

exports.generateArbiterToken = generateArbiterToken;


const updateArbiter = async function (data) {
	return new Promise(async (resolve, reject) => {
		console.log("[updateArbiter] DONE");
		const options = {
			url: DATABOX_ARBITER_ENDPOINT + "/cm/upsert-container-info",
			method: 'POST',
			form: data,
			agent: arbiterAgent,
			headers: {
				'x-api-key': arbiterKey
			}
		};
		console.log(options);
		request(
			options,
			function (err, response, body) {
				if (err) {
					reject(err);
					return;
				}
				console.log("[updateArbiter] DONE");
				resolve(JSON.parse(body));
			});
	});
};
exports.updateArbiter = updateArbiter;

const updateContainerPermissions = function (permissions) {

	return new Promise((resolve, reject) => {

		const options = {
			url: DATABOX_ARBITER_ENDPOINT + "/cm/grant-container-permissions",
			method: 'POST',
			form: permissions,
			agent: arbiterAgent,
			headers: {
				'x-api-key': arbiterKey
			}
		};
		request(
			options,
			function (err, response, body) {
				if (err) {
					reject(err);
					return;
				}
				resolve(JSON.parse(body));
			});
	});
};

const revokeContainerPermissions = function (permissions) {
	return new Promise((resolve, reject) => {

		const options = {
			url: DATABOX_ARBITER_ENDPOINT + "/cm/delete-container-info",
			method: 'POST',
			form: permissions,
			agent: arbiterAgent,
			headers: {
				'x-api-key': arbiterKey
			}
		};
		request(
			options,
			function (err, response, body) {
				if (err) {
					reject(err);
					return;
				}
				resolve();
			});

	});
};

const saveSLA = function (sla) {
	//console.log('[' + sla.name + '] Saving SLA');
	return db.putSLA(sla.name, sla);
};

exports.reloadInstalledComponents = function () {
	return new Promise((resolve, reject) => {
		getActiveSLAs()
		.then((slas)=>{
			slas.forEach(sla => {
				console.log("Launching previously installed component:: " + sla.name);
				install(sla)
			});
			resolve(slas)
		})
	});
}

let getActiveSLAs = function () {
	return db.getAllSLAs();
};
