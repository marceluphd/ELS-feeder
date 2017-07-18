"use strict";

const Promise = require('bluebird');
const config = require('./config');
const rp = require('request-promise');
const elasticsearch = require('elasticsearch');
const helpers = require('./helpers');
const log = require('./log');
const shortid = require('shortid');

const delay = 500; // time between requests at start (in ms)

const excludedAttributes = new Set(['id', 'type', 'owner']);

const tasks = {};

const TriggerTypes = {
    Time: 'time',
    Subscription: 'subscription'
};

class Task {
    constructor(conf) {
        this.conf = conf;
        this.subscriptionId = 0;
        this.orionConfig = config.mergeWith(conf.orion, 'orion');

        this.esConfig = config.mergeWith(conf.elasticsearch, 'elasticsearch');
        this.es = new elasticsearch.Client({
            host: `${this.esConfig.host}:${this.esConfig.port}`
            // , log: 'trace'
        });

        this.indexExists = new Map();
        this.cid = shortid.generate();
    }

    async init() {
        //based on indexName
        // Discard all existing subscriptions that could relate to this task (or some other from this instance of feeder)
        const expectedDesc = this._getSubscriptionDesc();
        try {
            const resp = await rp({
                uri: `${this.orionConfig.uri}/v2/subscriptions`,
                headers: {
                    'Fiware-Service': this.orionConfig.service,
                    'Fiware-ServicePath': this.orionConfig.servicePath
                },
                json: true
            });

            for (const entry of resp) {
                if (entry.description === expectedDesc) {
                    const resp = await rp({
                        method: 'DELETE',
                        uri: `${this.orionConfig.uri}/v2/subscriptions/${entry.id}`,
                        headers: {
                            'Fiware-Service': this.orionConfig.service,
                            'Fiware-ServicePath': this.orionConfig.servicePath
                        },
                        json: true
                    });
                }
            }
        } catch (err) {
            log.error(err);
        }
    }

    async createIndexes() {
        // Create index in Elasticsearch if it does not exist yet
        let allSps = await this.fetchSps();
        for (let sp of allSps) {
            //console.log(sp);
            let indexName = this.getIndex(sp);
            //console.log(indexName);
            //let indexExists = true; this.indexExists.indexName === true? true:
            if (this.indexExists.has(indexName) === false) {
                let indexExists = await this.es.indices.exists({ index: indexName });
            
                if (!indexExists) {
                    this.indexExists.indexName = true;
                    await this.es.indices.create({
                        index: indexName,
                        body: {
                            mappings: {
                                sensingNumber: {
                                    properties: {
                                        name: {
                                            type: 'keyword'
                                        },
                                        attribute: {
                                            type: 'keyword'
                                        },
                                        time: {
                                            type: 'date'
                                        },
                                        value: {
                                            type: 'double'
                                        }
                                    }
                                }
                            }
                        }
                    })
                }
            }
        }
    }

    async fetchSps() {
        try {
            const resp = await rp({
                uri: `${this.orionConfig.uri}/v2/entities?attrs=servicePath`,
                headers: {
                    'Fiware-Service': this.orionConfig.service,
                    'Fiware-ServicePath': this.orionConfig.servicePath
                },
                json: true
            });

            const spSet = new Set();

            for (const entry of resp) {
                spSet.add(entry.servicePath.value);
            }

            //console.log(spSet);
            return spSet;
        } catch (err) {
            log.error(err);
            return [];
        }
    }

    async fetchSensors() {
        try {
            const resp = await rp({
                uri: `${this.orionConfig.uri}/v2/entities?attrs=dateModified,servicePath,*`,
                headers: {
                    'Fiware-Service': this.orionConfig.service,
                    'Fiware-ServicePath': this.orionConfig.servicePath
                },
                json: true
            });

            return resp;
        } catch (err) {
            log.error(err);
            return [];
        }
    }

    async filterSensors(data) {
        try {
            const filter = this.conf.filter || {};
            const idsSet = filter.ids ? new Set(filter.ids) : null;
            const attributesSet = filter.attributes ? new Set(filter.attributes) : null;

            const results = [];

            for (const entry of data) {
                if (!idsSet || idsSet.has(entry.id)) {
                    const attributes = [];

                    for (const attrName in entry) {
                        if (!excludedAttributes.has(attrName) && (!attributesSet || attributesSet.has(attrName))) {
                            attributes.push({
                                name: attrName,
                                type: entry[attrName].type,
                                value: entry[attrName].value
                            });
                        }
                    }

                    results.push({
                        name: entry.id,
                        servicePath: entry.servicePath.value,
                        attributes
                    });
                }
            }

            return results;

        } catch (err) {
            log.error(err);
            return [];
        }
    }

    getIndex(servicePath) {
        let index = this.orionConfig.service;
        if (servicePath !== '/') {
            const spPart = servicePath.replace(/\//g, "-");
            index = index.concat(spPart);
        }
        return index.toLowerCase();
    }

    async feedToElasticsearch(sensors) {
        const docTime = new Date();
        const bulkBody = [];
        
        await this.createIndexes();
        for (const sensor of sensors) {
            let index = this.getIndex(sensor.servicePath);
            
            for (const attribute of sensor.attributes) {
                if (attribute.type === 'Number' || 
                attribute.type === 'geo:json' ||
                attribute.type === 'string' ||
                attribute.type === 'Text' ||
                attribute.type === 'DateTime') {
                    log.info(`Feeding sensor value: ${this.orionConfig.service} ${sensor.name}.${attribute.name} @ ${docTime} = ${attribute.value}`);

                    bulkBody.push({
                        index: {
                            _index: index,
                            _type: 'sensingNumber'
                        }
                    });

                    bulkBody.push({
                        name: sensor.name,
                        attribute: attribute.name,
                        time: docTime.getTime(),
                        value: attribute.value
                    });

                } else {
                    log.error(`Unsupported attribute type: ${attribute.type} in ${this.orionConfig.service} ${sensor.name}.${attribute.name}`);
                }
            }
        }

        if (bulkBody.length > 0) {
            await this.es.bulk({ body: bulkBody });
        }
    }

    _getSubscriptionDesc() {
        return `Orion-Elasticsearch Feeder instance ${this.orionConfig.service} ${config.get('endpoint.id')}`;
    }

    subscribe(sensors) {
        const entities = sensors.map(sensor => {
            return {
                id: sensor.name
            };
        });

        log.info(`Subscribing to entities: ${this.orionConfig.service} ${this.orionConfig.servicePath} ${entities.map(entity => entity.id).join(', ')}`);

        const sub = {
            description: this._getSubscriptionDesc(),
            subject: {
                entities
            },
            notification: {
                http: {
                    url: `${config.get('endpoint.url')}/api/update/${this.cid}`
                }
            }
        };

        if (this.conf.throttling) {
            sub.throttling = this.conf.throttling;
        }

        /*console.log(sub);
        console.log("s and sp");
        console.log(service, this.orionConfig.servicePath);*/

        return new Promise(resolve => {
            rp({
                method: 'POST',
                uri: `${this.orionConfig.uri}/v2/subscriptions`,
                headers: {
                    'Fiware-Service': this.orionConfig.service,
                    'Fiware-ServicePath': this.orionConfig.servicePath
                },
                body: sub,
                json: true
            }, (err, msg, body) => {
                if (err) {
                    log.error(err);
                } else {
                    if (!msg.headers.location) {
                        log.error('Subscription failed.')
                    } else {
                        this.subscriptionId = msg.headers.location.replace(/.*v2\/subscriptions\/(.*)/, '$1');
                    }
                }

                resolve();
            });
        });
    }

    async unsubscribe() {
        try {
            const resp = await rp({
                method: 'DELETE',
                uri: `${this.orionConfig.uri}/v2/subscriptions/${this.subscriptionId}`,
                headers: {
                    'Fiware-Service': this.orionConfig.service,
                    'Fiware-ServicePath': this.orionConfig.servicePath
                },
                json: true
            });
        } catch (err) {
            log.error(err);
        }
    }

    async doPeriod() {
        if (this.subscriptionId) {
            await this.unsubscribe();
        }

        const data = await this.fetchSensors();
        const sensors = await this.filterSensors(data);
        if (this.conf.trigger === TriggerTypes.Subscription) {
            await this.subscribe(sensors);
        } else {
            await this.feedToElasticsearch(sensors);
        }
    }
}

async function feedData(taskCid, data) {
    const task = tasks[taskCid];
    const sensors = await task.filterSensors(data);
    await task.feedToElasticsearch(sensors);
}

async function run() {
    const taskConfs = config.get('tasks');

    //log.info(`Run method: taskConfs ${taskConfs}`);
    for (const conf of taskConfs) {
        const task = new Task(conf);
        await task.init();
        tasks[task.cid] = task;
    }

    //log.info(`Run method: tasks ${tasks}`);

    let accumulatedDelay = 0;
    for (const taskCid in tasks) {
        const task = tasks[taskCid];
        //log.info(`Run method: task ${task} taskCid ${taskCid}`);
        setTimeout(async () => {
            await task.doPeriod();
            if (task.conf.period) {
                setInterval(() => task.doPeriod(), task.conf.period);
            }
        }, accumulatedDelay);

        accumulatedDelay += delay;
    }
}

module.exports.run = run;
module.exports.feedData = feedData;
