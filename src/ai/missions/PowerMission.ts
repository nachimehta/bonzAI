import {Mission} from "./Mission";
import {Operation} from "../operations/Operation";
import {PowerFlagScan, BankData} from "../../interfaces";
import {helper} from "../../helpers/helper";
import {ALLIES} from "../../config/constants";
import {notifier} from "../../notifier";

export class PowerMission extends Mission {

    clydes: Creep[];
    bonnies: Creep[];
    carts: Creep[];

    memory: {
        currentBank: BankData;
        scanIndex: number;
        scanData: {[roomName: string]: number}
    };

    constructor(operation: Operation) {
        super(operation, "power");
    }

    initMission() {

        let observer = this.room.findStructures(STRUCTURE_OBSERVER)[0] as StructureObserver;
        if (!observer) return;

        if (!Memory.powerObservers[this.room.name]) {
            Memory.powerObservers[this.room.name] = this.generateScanData();
            return;
        }

        if (this.memory.currentBank) {
            this.monitorBank(this.memory.currentBank);
        }
        else {
            this.scanForBanks(observer);
        }
    }

    roleCall() {
        let max = 0;
        let distance;
        if (this.memory.currentBank && !this.memory.currentBank.finishing && !this.memory.currentBank.assisting) {
            max = 1;
            distance = this.memory.currentBank.distance;
        }

        this.bonnies = this.headCount("bonnie", () => this.configBody({ move: 25, heal: 25}), max, {
            prespawn: distance,
            reservation: { spawns: 2, currentEnergy: 8000 }
        });

        this.clydes = this.headCount("clyde", () => this.configBody({ move: 20, attack: 20}), this.bonnies.length);

        let unitsPerCart = 1;
        let maxCarts = 0;
        if (this.memory.currentBank && this.memory.currentBank.finishing && !this.memory.currentBank.assisting) {
            let unitsNeeded = Math.ceil(this.memory.currentBank.power / 100);
            maxCarts = Math.ceil(unitsNeeded / 16);
            unitsPerCart = Math.ceil(unitsNeeded / maxCarts);
        }

        this.carts = this.headCount("powerCart", () => this.workerBody(0, unitsPerCart * 2, unitsPerCart), maxCarts);
    }

    missionActions() {
        for (let i = 0; i < 2; i++) {
            let clyde = this.clydes[i];
            if (clyde) {
                if (!clyde.memory.myBonnieName) {
                    if (this.clydes.length === this.bonnies.length) {
                        clyde.memory.myBonnieName = this.bonnies[i].name;
                    }
                }
                else {
                    this.clydeActions(clyde);
                    this.checkForAlly(clyde);
                }
            }
            let bonnie = this.bonnies[i];
            if (bonnie) {
                if (!bonnie.memory.myClydeName) {
                    if (this.clydes.length === this.bonnies.length) {
                        bonnie.memory.myClydeName = this.clydes[i].name;
                    }
                }
                else {
                    this.bonnieActions(bonnie);
                }
            }
        }

        if (this.carts) {
            let order = 0;
            for (let cart of this.carts) {
                this.powerCartActions(cart, order);
                order++;
            }
        }
    }

    finalizeMission() {
    }

    invalidateMissionCache() {
    }

    findAlleysInRange(range: number) {

        let roomNames = [];

        for (let i = this.room.coords.x - range; i <= this.room.coords.x + range; i++) {
            for (let j = this.room.coords.y - range; j <= this.room.coords.y + range; j++) {
                let x = i;
                let xDir = this.room.coords.xDir;
                let y = j;
                let yDir = this.room.coords.yDir;
                if (x < 0) {
                    x = Math.abs(x) - 1;
                    xDir = helper.negaDirection(xDir);
                }
                if (y < 0) {
                    y = Math.abs(y) - 1;
                    yDir = helper.negaDirection(yDir);
                }
                let roomName = xDir + x + yDir + y;
                if ((x % 10 === 0 || y % 10 === 0) && Game.map.isRoomAvailable(roomName)) {
                    roomNames.push(roomName);
                }
            }
        }

        return roomNames;
    }

    private clydeActions(clyde: Creep) {

        let myBonnie = Game.creeps[clyde.memory.myBonnieName];
        if (!myBonnie || (!clyde.pos.isNearTo(myBonnie) && !clyde.isNearExit(1))) {
            clyde.idleOffRoad(this.flag);
            return;
        }

        if (!this.memory.currentBank) {
            console.log(`POWER: clyde checking out: ${clyde.room.name}`);
            clyde.suicide();
            myBonnie.suicide();
            return;
        }

        let bankPos = helper.deserializeRoomPosition(this.memory.currentBank.pos);

        if (clyde.pos.isNearTo(bankPos)) {
            clyde.memory.inPosition = true;
            let bank = bankPos.lookForStructure(STRUCTURE_POWER_BANK);
            if (bank) {
                if (bank.hits > 600 || clyde.ticksToLive < 5) {
                    clyde.attack(bank);
                }
                else {
                    // wait for carts
                    for (let cart of this.carts) {
                        if (!bankPos.inRangeTo(cart, 5)) {
                            return;
                        }
                    }
                    clyde.attack(bank);
                }
            }
        }
        else if (myBonnie.fatigue === 0) {
            if (this.memory.currentBank.assisting === undefined) {
                // traveling from spawn
                this.empire.travelTo(clyde, {pos: bankPos}, {ignoreRoads: true});
            }
            else {
                clyde.moveTo(bankPos, {reusePath: 0});
            }
        }
    }

    private bonnieActions(bonnie: Creep) {
        let myClyde = Game.creeps[bonnie.memory.myClydeName];
        if (!myClyde) {
            return;
        }

        if (myClyde.ticksToLive === 1) {
            bonnie.suicide();
            return;
        }

        if (bonnie.pos.isNearTo(myClyde)) {
            if (myClyde.memory.inPosition) {
                bonnie.heal(myClyde);
            }
            else {
                bonnie.move(bonnie.pos.getDirectionTo(myClyde));
            }
        }
        else {
            bonnie.blindMoveTo(myClyde);
        }
    }

    private powerCartActions(cart: Creep, order: number) {
        if (!cart.carry.power) {
            if (this.memory.currentBank && this.memory.currentBank.finishing) {
                this.powerCartApproachBank(cart, order);
                return;
            }
            else {
                let power = cart.room.find(FIND_DROPPED_RESOURCES,
                    { filter: (r: Resource) => r.resourceType === RESOURCE_POWER})[0] as Resource;
                if (power) {
                    if (cart.pos.isNearTo(power)) {
                        cart.pickup(power);
                        cart.blindMoveTo(this.room.storage);
                    }
                    else {
                        cart.blindMoveTo(power);
                    }
                    return; //  early;
                }
            }

            this.recycleCreep(cart);
            return; // early
        }

        if (cart.pos.isNearTo(this.room.storage)) {
            cart.transfer(this.room.storage, RESOURCE_POWER);
        }
        else {
            // traveling to storage
            this.empire.travelTo(cart, this.room.storage);
        }
    }

    private powerCartApproachBank(cart: Creep, order: number) {
        let bankPos = helper.deserializeRoomPosition(this.memory.currentBank.pos);
        if (!cart.pos.inRangeTo(bankPos, 5)) {
            // traveling from spawn
            this.empire.travelTo(cart, {pos: bankPos}, {ignoreRoads: true});
        }
        else {
            if (!cart.memory.inPosition) {
                if (bankPos.openAdjacentSpots().length > 0) {
                    if (cart.pos.isNearTo(bankPos)) {
                        cart.memory.inPosition = true;
                    }
                    else {
                        cart.blindMoveTo(bankPos);
                    }
                }
                else if (order > 0) {
                    if (cart.pos.isNearTo(this.carts[order - 1])) {
                        cart.memory.inPosition = true;
                    }
                    else {
                        cart.blindMoveTo(this.carts[order - 1]);
                    }
                }
                else {
                    if (cart.pos.isNearTo(this.clydes[0])) {
                        cart.memory.inPosition = true;
                    }
                    else {
                        cart.blindMoveTo(this.clydes[0]);
                    }
                }
            }
        }
    }

    private checkForAlly(clyde: Creep) {
        if (clyde.isNearExit(1) || !this.memory.currentBank || !this.memory.currentBank.assisting !== undefined) return;

        let bank = clyde.room.findStructures<StructurePowerBank>(STRUCTURE_POWER_BANK)[0];
        if (!bank) return;

        let allyClyde = bank.room.find(FIND_HOSTILE_CREEPS, {
            filter: (c: Creep) => c.partCount(ATTACK) === 20 && ALLIES[c.owner.username] && !c.isNearExit(1)
        })[0] as Creep;

        if (!allyClyde) {
            return;
        }

        if (clyde.memory.play) {
            let myPlay = clyde.memory.play;
            let allyPlay = allyClyde.saying;
            if (!allyPlay || allyPlay === myPlay) {
                console.log("POWER: we had a tie!");
                clyde.say("tie!", true);
                clyde.memory.play = undefined;
            }
            else if ((allyPlay === "rock" && myPlay === "scissors") || (allyPlay === "scissors" && myPlay === "paper") ||
                (allyPlay === "paper" && myPlay === "rock")) {
                if (bank.pos.openAdjacentSpots(true).length === 1) {
                    let bonnie = Game.creeps[clyde.memory.myBonnieName];
                    bonnie.suicide();
                    clyde.suicide();
                }
                this.memory.currentBank.assisting = true;
                clyde.say("damn", true);
                notifier.add(`"POWER: ally gets the power! ${bank.room.name}`);
            }
            else {
                this.memory.currentBank.assisting = false;
                clyde.say("yay!", true);
                notifier.add(`"POWER: I get the power! ${bank.room.name}`);
            }
        }
        else {
            console.log("POWER: ally found in", clyde.room.name, "playing a game to find out who gets power");
            let random = Math.floor(Math.random() * 3);
            let play;
            if (random === 0) {
                play = "rock";
            }
            else if (random === 1) {
                play = "paper";
            }
            else if (random === 2) {
                play = "scissors";
            }
            clyde.memory.play = play;
            clyde.say(play, true);
        }
    }

    private generateScanData(): {[roomName: string]: number} {
        if (Game.cpu.bucket < 10000) return;

        let scanData: {[roomName: string]: number} = {};
        let spawn = this.spawnGroup.spawns[0];
        let possibleRoomNames = this.findAlleysInRange(5);
        for (let roomName of possibleRoomNames) {
            let position = helper.pathablePosition(roomName);
            let ret = this.empire.findTravelPath(spawn, {pos: position});
            if (ret.incomplete) {
                notifier.add(`POWER: incomplete path generating scanData (op: ${this.opName}, roomName: ${roomName})`);
                continue;
            }

            let currentObserver = _.find(Memory.powerObservers, (value) => value[roomName]);
            let distance = ret.path.length;
            if (distance > 250) continue;

            if (currentObserver) {
                if (currentObserver[roomName] > distance) {
                    console.log(`POWER: found better distance for ${roomName} at ${this.opName}, ` +
                        `${currentObserver[roomName]} => ${distance}`);
                    delete currentObserver[roomName];
                }
                else {
                    continue;
                }
            }

            scanData[roomName] = distance;
        }

        console.log(`POWER: found ${Object.keys(scanData).length} rooms for power scan in ${this.opName}`);
        return scanData;
    }

    private monitorBank(currentBank: BankData) {
        let room = Game.rooms[currentBank.pos.roomName];
        if (room) {
            let bank = room.findStructures<StructurePowerBank>(STRUCTURE_POWER_BANK)[0];
            if (bank) {
                currentBank.hits = bank.hits;
                if (!currentBank.finishing && bank.hits < 500000) {
                    let clyde = bank.pos.findInRange<Creep>(
                        _.filter(room.find<Creep>(FIND_MY_CREEPS), (c: Creep) => c.partCount(ATTACK) === 20), 1)[0];
                    if (clyde && bank.hits < clyde.ticksToLive * 600) {
                        console.log(`POWER: last wave needed for bank has arrived, ${this.opName}`);
                        currentBank.finishing = true;
                    }
                }
            }
            else {
                this.memory.currentBank = undefined;
            }
        }
        if (Game.time > currentBank.timeout) {
            notifier.add(`POWER: bank timed out ${JSON.stringify(currentBank)}`);
            this.memory.currentBank = undefined;
        }
    }

    private scanForBanks(observer: StructureObserver) {

        if (observer.observation && observer.observation.purpose === this.name) {
            let room = observer.observation.room;
            let bank = observer.observation.room.findStructures<StructurePowerBank>(STRUCTURE_POWER_BANK)[0];
            if (bank && bank.ticksToDecay > 4500 && room.findStructures(STRUCTURE_WALL).length === 0
                && bank.power >= Memory.playerConfig.powerMinimum) {
                console.log("\\o/ \\o/ \\o/", bank.power, "power found at", room, "\\o/ \\o/ \\o/");
                this.memory.currentBank = {
                    pos: bank.pos,
                    hits: bank.hits,
                    power: bank.power,
                    distance: Memory.powerObservers[this.room.name][room.name],
                    timeout: Game.time + bank.ticksToDecay,
                };
                return;
            }
        }

        if (this.spawnGroup.averageAvailability < .5 || Math.random() > .2) { return; }

        let scanData = Memory.powerObservers[this.room.name];
        if (this.memory.scanIndex >= Object.keys(scanData).length) { this.memory.scanIndex = 0; }
        let roomName = Object.keys(scanData)[this.memory.scanIndex++];
        observer.observeRoom(roomName, this.name);
    }
}