// Resale value of outfits, following source/Depreciation.cpp with the default gamerules
// (data/gamerules.txt: min 0.25, grace period 7 days, max age 1000 days, daily 0.997).
const MIN = 0.25, GRACE = 7, MAX_AGE = 1000 + GRACE, DAILY = 0.997;
const MDAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

// Date::DaysSinceEpoch: the day numbers used as keys in the save's depreciation records.
export function daysSinceEpoch(day: number, month: number, year: number): number {
	let days = day + MDAYS[month - 1];
	if(month > 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))
		++days;
	--year;
	days += 146097 * Math.floor(year / 400);
	year %= 400;
	days += 36524 * Math.floor(year / 100);
	year %= 100;
	days += 1461 * Math.floor(year / 4);
	year %= 4;
	return days + 365 * year;
}

// Fraction of its cost an outfit bought `age` days ago is still worth.
export function depreciate(age: number): number {
	if(age <= GRACE)
		return 1;
	if(age >= MAX_AGE)
		return MIN;
	const effective = age - GRACE;
	return MIN + (1 - MIN) * DAILY ** effective * ((MAX_AGE - effective) / MAX_AGE);
}

// Purchase day -> number of copies bought that day, for one outfit across the whole fleet.
export type AgeRecord = Array<[number, number]>;

// What the player gets for selling `count` copies: the game sells the newest copies first (Depreciation::Depreciate
// for a fleet), and copies with no record count as fully depreciated.
export function resaleValue(record: AgeRecord | undefined, cost: number, count: number, today: number): number {
	let remaining = count, fraction = 0;
	for(const [day, copies] of [...(record ?? [])].sort((a, b) => b[0] - a[0]))
	{
		const used = Math.min(copies, remaining);
		fraction += used * depreciate(today - day);
		remaining -= used;
		if(!remaining)
			break;
	}
	fraction += remaining * MIN;
	return Math.round(fraction * cost);
}
