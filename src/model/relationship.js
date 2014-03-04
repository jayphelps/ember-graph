var BELONGS_TO_KEY = Eg.Model.BELONGS_TO_KEY = 'belongsTo';
var HAS_MANY_KEY = Eg.Model.HAS_MANY_KEY = 'hasMany';

var NEW_STATE = Eg.Relationship.NEW_STATE;
var SAVED_STATE = Eg.Relationship.SAVED_STATE;
var DELETED_STATE = Eg.Relationship.DELETED_STATE;

var disallowedRelationshipNames = new Em.Set(['id', 'type', 'content']);

Eg.hasMany = function(options) {
	return {
		isRelationship: true,
		kind: HAS_MANY_KEY,
		options: options
	};
};

Eg.belongsTo = function(options) {
	return {
		isRelationship: true,
		kind: BELONGS_TO_KEY,
		options: options
	};
};

var createRelationship = function(kind, options) {
	Em.assert('Your relationship must specify a relatedType.', typeof options.relatedType === 'string');
	Em.assert('Your relationship must specify an inverse relationship.',
		options.inverse === null || typeof options.inverse === 'string');

	var meta = {
		isRelationship: false,
		kind: kind,
		isRequired: (options.hasOwnProperty('defaultValue') ? false : options.isRequired !== false),
		defaultValue: options.defaultValue || (kind === HAS_MANY_KEY ? [] : null),
		relatedType: options.relatedType,
		inverse: options.inverse,
		readOnly: options.readOnly === true
	};

	Em.assert('The default value for a belongsToRelationship must be a string or null, and the default value' +
			'for a hasMany relationship must be an array.',
			(kind === HAS_MANY_KEY && Em.isArray(meta.defaultValue)) ||
			(kind === BELONGS_TO_KEY && (meta.defaultValue === null || typeof meta.defaultValue === 'string')));

	var relationship;

	if (kind === HAS_MANY_KEY) {
		relationship = function(key) {
			return this._hasManyValue(key.substring(1));
		};
	} else {
		relationship = function(key) {
			return this._belongsToValue(key.substring(1));
		};
	}

	return Em.computed(relationship).property('_serverRelationships', '_clientRelationships').meta(meta).readOnly();
};

Eg.Model.reopenClass({

	/**
	 * Goes through the subclass and declares an additional property for
	 * each relationship. The properties will be capitalized and then prefixed
	 * with 'loaded'. So rather than 'projects', use 'loadedProjects'.
	 * This will return the relationship as a promise rather than in ID form.
	 *
	 * @static
	 * @private
	 */
	_declareRelationships: function(relationships) {
		var obj = {};

		Em.keys(relationships).forEach(function(name) {
			var kind = relationships[name].kind;
			var options = relationships[name].options;
			var relatedType = options.relatedType;

			var relationship;

			if (kind === HAS_MANY_KEY) {
				relationship = function() {
					return this.get('store').find(relatedType, this.get('_' + name).toArray());
				};
			} else {
				relationship = function() {
					return this.get('store').find(relatedType, this.get('_' + name));
				};
			}

			obj['_' + name] = createRelationship(kind, options);
			var meta = Em.copy(obj['_' + name].meta(), true);
			meta.isRelationship = true;
			obj[name] = relationship.property('_' + name).meta(meta).readOnly();
		});

		this.reopen(obj);
	},

	/**
	 * @static
	 * @type {Set}
	 */
	relationships: Em.computed(function() {
		var relationships = new Em.Set();

		this.eachComputedProperty(function(name, meta) {
			if (meta.isRelationship) {
				Eg.debug.assert('The ' + name + ' cannot be used as a relationship name.',
					!disallowedRelationshipNames.contains(name));
				Eg.debug.assert('Relationship names must start with a lowercase letter.', name[0].match(/[a-z]/g));

				relationships.addObject(name);
			}
		});

		return relationships;
	}).property(),

	/**
	 * @param {String} name
	 * @returns {Boolean}
	 * @static
	 */
	isRelationship: function(name) {
		return Em.get(this, 'relationships').contains(name);
	},

	/**
	 * Just a more semantic alias for `metaForProperty`
	 * @alias metaForProperty
	 * @static
	 */
	metaForRelationship: Em.aliasMethod('metaForProperty'),

	/**
	 * @param name The name of the relationships
	 * @returns {String} HAS_MANY_KEY or BELONGS_TO_KEY
	 * @static
	 */
	relationshipKind: function(name) {
		return this.metaForRelationship(name).kind;
	},

	/**
	 * Calls the callback for each relationship defined on the model.
	 *
	 * @param {Function} callback Function that takes `name` and `meta` parameters
	 * @param {*} [binding] Object to use as `this`
	 * @static
	 */
	eachRelationship: function(callback, binding) {
		this.eachComputedProperty(function(name, meta) {
			if (meta.isRelationship) {
				callback.call(binding, name, meta);
			}
		});
	},

	/**
	 * Alerts the records and properties in the given array.
	 *
	 * @param {Object[]} properties Objects of the type returned by relationship functions
	 * @private
	 */
	_notifyProperties: function(properties) {
		properties.forEach(function(property) {
			try {
				var obj = property.record;
				var name = property.property;

				if (obj.constructor.isRelationship && obj.constructor.isRelationship(name)) {
					obj.notifyPropertyChange('_' + name);
				} else {
					obj.notifyPropertyChange(name);
				}
			} catch (e) {
				Em.warn(e);
			}
		}, this);
	}
});

Eg.Model.reopen({

	/**
	 * Relationships that have been saved to the server
	 * that are currently connected to this record.
	 *
	 * @type {Object.<String, Relationship>}
	 */
	_serverRelationships: null,

	/**
	 * Relationships that have been saved to the server, but aren't currently
	 * connected to this record and are scheduled for deletion on the next save.
	 *
	 * @type {Object.<String, Relationship>}
	 */
	_deletedRelationships: null,

	/**
	 * Relationships that have been created on the client and haven't been
	 * saved to the server yet. Relationships from here that are disconnected
	 * are deleted completely rather than queued for deletion.
	 *
	 * @type {Object.<String, Relationship>}
	 */
	_clientRelationships: null,

	/**
	 * Determines the value of a belongsTo relationship, either the
	 * original value sent from the server, or the current client value.
	 *
	 * @param {String} relationship
	 * @param {Boolean} server True for original value, false for client value
	 * @returns {String}
	 * @private
	 */
	_belongsToValue: function(relationship, server) {
		var serverRelationships = Eg.util.values(this.get('_serverRelationships'));
		var otherRelationships = Eg.util.values(this.get((server ? '_deleted' : '_client') + 'Relationships'));
		var current = serverRelationships.concat(otherRelationships);

		for (var i = 0; i < current.length; i = i + 1) {
			if (current[i].relationshipName(this) === relationship) {
				return current[i].otherId(this);
			}
		}

		return null;
	},

	/**
	 * Determines the value of a hasMany relationship, either the
	 * original value sent from the server, or the current client value.
	 *
	 * @param {String} relationship
	 * @param {Boolean} server True for original value, false for client value
	 * @returns {Set}
	 * @private
	 */
	_hasManyValue: function(relationship, server) {
		var serverRelationships = Eg.util.values(this.get('_serverRelationships'));
		var otherRelationships = Eg.util.values(this.get((server ? '_deleted' : '_client') + 'Relationships'));
		var current = serverRelationships.concat(otherRelationships);

		var found = [];
		for (var i = 0; i < current.length; i = i + 1) {
			if (current[i].relationshipName(this) === relationship) {
				found.push(current[i].otherId(this));
			}
		}

		return new Em.Set(found);
	},

	/**
	 * Watches the client side attributes for changes and detects if there are
	 * any dirty attributes based on how many client attributes differ from
	 * the server attributes.
	 */
	_areRelationshipsDirty: Em.computed(function() {
		var client = Em.keys(this.get('_clientRelationships')).length > 0;
		var deleted = Em.keys(this.get('_deletedRelationships')).length > 0;

		return client || deleted;
	}).property('_clientRelationships', '_deletedRelationships'),

	/**
	 * Gets all relationships currently linked to this record.
	 *
	 * @returns {Relationship[]}
	 * @private
	 */
	_getAllRelationships: function() {
		var server = Eg.util.values(this.get('_serverRelationships'));
		var client = Eg.util.values(this.get('_clientRelationships'));
		var deleted = Eg.util.values(this.get('_deletedRelationships'));

		return server.concat(client.concat(deleted));
	},

	/**
	 * Loads relationships from the server. Completely replaces
	 * the current relationships with the given ones.
	 *
	 * TODO: Clean this shit up yo...
	 *
	 * @param json The JSON with properties to load
	 * @private
	 */
	_loadRelationships: function(json) {
		var alerts = [];
		var store = this.get('store');
		var sideWithClient = store.get('sideWithClientOnConflict');

		this.constructor.eachRelationship(function(name, meta) {
			if (meta.isRequired && !json.hasOwnProperty(name)) {
				throw new Error('You left out the required \'' + name + '\' relationship.');
			}

			var value = json[name] || meta.defaultValue;

			// Delete ALL server relationships with this name
			var client = this._relationshipsForName(name).filter(function(relationship) {
				// If a DELETED relationship is the same as one given by the server
				// it's considered a conflict and has to be dealt with accordingly
				var state = relationship.get('state');
				if (state === DELETED_STATE) {
					var otherId = relationship.otherId(this);

					if (meta.kind === HAS_MANY_KEY) {
						if (new Em.Set(value).contains(otherId)) {
							if (sideWithClient) {
								// Leave it alone
							} else {
								alerts = alerts.concat(
									store._changeRelationshipState(relationship.get('id'), SAVED_STATE));
							}
						}
					} else {
						if (value === otherId) {
							if (sideWithClient) {
								// Leave it alone
							} else {
								alerts = alerts.concat(
									store._changeRelationshipState(relationship.get('id'), SAVED_STATE));
							}
						}
					}

					return false;
				}

				if (state === SAVED_STATE) {
					alerts = alerts.concat(store._deleteRelationship(relationship.get('id')));
					return false;
				} else {
					return true;
				}
			}, this);

			if (meta.kind === HAS_MANY_KEY) {
				var given = new Em.Set(value);

				// Update client side relationships that have been saved
				client.forEach(function(relationship) {
					if (given.contains(relationship.otherId(this))) {
						alerts = alerts.concat(store._changeRelationshipState(relationship.get('id'), SAVED_STATE));
					}
				}, this);

				var current = this._hasManyValue(name);
				// These are OK for now, because they're not in conflict
				var clientNotOnServer = current.without(given);
				// These have to be created
				var serverNotInClient = given.without(current);
				serverNotInClient.forEach(function(id) {
					var addState = SAVED_STATE;
					var conflict = this._belongsToConflict(name, id);
					if (conflict !== null) {
						switch (conflict.get('state')) {
							case DELETED_STATE:
							case SAVED_STATE:
								// Delete it because the server says that relationship no longer exists.
								// It is now occupied by another relationship
								alerts = alerts.concat(store._deleteRelationship(conflict.get('id')));
								break;
							case NEW_STATE:
								if (sideWithClient) {
									// We have to side with the client, so leave it alone, add ours as deleted
									addState = DELETED_STATE;
								} else {
									// We have to side with the server, so delete it
									alerts = alerts.concat(store._deleteRelationship(conflict.get('id')));
								}
								break;
						}
					}

					alerts = alerts.concat(store._createRelationship(this.typeKey, name, this.get('id'),
						meta.relatedType, meta.inverse, id, addState));
				}, this);
			} else {
				// There should only be one relationship in there
				Eg.debug.assert('An unknown relationship error occurred.', client.length <= 1);

				var conflict = this._belongsToConflict(name, value);

				// Update client side relationships that have been saved
				if (client.length === 1) {
					if (client[0].otherId(this) === value) {
						alerts = alerts.concat(store._changeRelationshipState(client[0].get('id'), SAVED_STATE));
					} else {
						// The server is in conflict with the client
						if (sideWithClient) {
							if (value !== null) {
								if (conflict !== null) { // jshint ignore:line
									switch (conflict.get('state')) {
										case DELETED_STATE:
										case SAVED_STATE:
											// Delete it because the server says that relationship no longer exists.
											// It is now occupied by another relationship
											alerts = alerts.concat(store._deleteRelationship(conflict.get('id')));
											break;
										case NEW_STATE:
											// We have to side with the client, so leave it alone
											break;
									}
								}

								// Add the server relationship as deleted
								alerts = alerts.concat(store._createRelationship(this.typeKey, name, this.get('id'),
									meta.relatedType, meta.inverse, value, DELETED_STATE));
							}
						} else {
							// Delete the client side relationship
							alerts = alerts.concat(store._deleteRelationship(client[0].get('id')));
							if (value !== null) {
								if (conflict !== null) { // jshint ignore:line
									// Delete it because the server says that relationship no longer exists.
									// It is now occupied by another relationship
									alerts = alerts.concat(store._deleteRelationship(conflict.get('id')));
								}

								alerts = alerts.concat(store._createRelationship(this.typeKey, name, this.get('id'),
									meta.relatedType, meta.inverse, value, SAVED_STATE));
							}
						}
					}
				} else if (client.length === 0) {
					// We can simply create the server relationship
					if (value !== null) {
						if (conflict !== null) { // jshint ignore:line
							// Delete it because the server says that relationship no longer exists.
							// It is now occupied by another relationship
							alerts = alerts.concat(store._deleteRelationship(conflict.get('id')));
						}

						alerts = alerts.concat(store._createRelationship(this.typeKey, name, this.get('id'),
							meta.relatedType, meta.inverse, value, SAVED_STATE));
					}
				} else {
					// TODO: This should really never happen in production.
					// What should we do? Can we guarantee this never happens?
				}
			}
		}, this);

		this.constructor._notifyProperties(alerts);
	},

	/**
	 * This method is used to determine if adding a relationship will create
	 * a conflict on the other side of the relationship with a belongsTo
	 * relationship. If there is a conflict on the other record, this will
	 * return the relationship that is in conflict.
	 *
	 * @param {String} relationship Relationship on this side that goes to the other record
	 * @param {String} id ID of the other record
	 * @returns {Relationship}
	 * @private
	 */
	_belongsToConflict: function(relationship, id) {
		if (id === null) {
			return null;
		}

		var meta = this.constructor.metaForRelationship(relationship);
		if (meta.inverse === null) {
			return null;
		}

		var model = this.get('store').modelForType(meta.relatedType);
		var otherMeta = model.metaForRelationship(meta.inverse);
		if (otherMeta.kind !== BELONGS_TO_KEY) {
			return null;
		}

		// We need to detect unloaded records too
		var record = this.get('store').getRecord(meta.relatedType, id);
		if (record) {
			var current = record._belongsToValue(meta.inverse);
			if (current === null || current === this.get('id')) {
				return null;
			}

			return record._findLinkTo(meta.inverse, current);
		} else {
			var relationships = this.get('store')._relationshipsForRecord(meta.relatedType, meta.inverse, id);
			if (relationships.length === 0) {
				return null;
			}

			// It's a belongsTo, so relationships can only have one NEW or SAVED relationship
			relationships = relationships.filter(function(relationship) {
				 var state = relationship.get('state');
				return (state === SAVED_STATE || state === NEW_STATE);
			});

			Eg.debug.assert('An unknown relationship error occurred', relationships.length <= 1);

			return (relationships.length > 0 ? relationships[0] : null);
		}
	},

	/**
	 * @returns {Object} Keys are relationship names, values are arrays with [oldVal, newVal]
	 */
	changedRelationships: function() {
		var changed = {};

		this.constructor.eachRelationship(function(name, meta) {
			var oldVal, newVal;

			if (meta.kind === HAS_MANY_KEY) {
				oldVal = this._hasManyValue(name, true);
				newVal = this._hasManyValue(name, false);

				if (!oldVal.isEqual(newVal)) {
					changed[name] = [oldVal, newVal];
				}
			} else {
				oldVal = this._belongsToValue(name, true);
				newVal = this._belongsToValue(name, false);

				if (oldVal !== newVal) {
					changed[name] = [oldVal, newVal];
				}
			}
		}, this);

		return changed;
	},

	/**
	 * Resets all relationship changes to last known server relationships.
	 */
	rollbackRelationships: function() {
		var alerts = [];
		var store = this.get('store');

		this._getAllRelationships().forEach(function(relationship) {
			switch (relationship.get('state')) {
				case NEW_STATE:
					alerts = alerts.concat(store._deleteRelationship(relationship.get('id')));
					break;
				case SAVED_STATE:
					// NOP
					break;
				case DELETED_STATE:
					alerts = alerts.concat(store._changeRelationshipState(relationship.get('id'), SAVED_STATE));
					break;
			}
		}, this);

		this.constructor._notifyProperties(alerts);
	},

	/**
	 * A convenience method to add an item to a hasMany relationship. This will
	 * ensure that all of the proper observers are notified of the change.
	 *
	 * @param {String} relationship The relationship to modify
	 * @param {String} id The ID to add to the relationship
	 */
	addToRelationship: function(relationship, id) {
		var alerts = [];
		var store = this.get('store');
		var meta = this.constructor.metaForRelationship(relationship);
		Eg.debug.assert('Cannot modify a read-only relationship', meta.readOnly === false);
		if (meta.readOnly) {
			return;
		}

		var link = this._findLinkTo(relationship, id);
		if (link && (link.get('state') === NEW_STATE || link.get('state') === SAVED_STATE)) {
			return;
		}

		if (link && link.get('state') === DELETED_STATE) {
			alerts = alerts.concat(this.get('store')._changeRelationshipState(link.get('id'), SAVED_STATE));
			this.constructor._notifyProperties(alerts);
			return;
		}

		var conflict = this._belongsToConflict(relationship, id);
		if (conflict !== null) {
			switch (conflict.get('state')) {
				case DELETED_STATE:
					// NOP
					break;
				case SAVED_STATE:
					alerts = alerts.concat(store._changeRelationshipState(conflict.get('id'), DELETED_STATE));
					break;
				case NEW_STATE:
					alerts = alerts.concat(store._deleteRelationship(conflict.get('id')));
					break;
			}
		}

		alerts = alerts.concat(store._createRelationship(this.typeKey, relationship,
			this.get('id'), meta.relatedType, meta.inverse, id, NEW_STATE));

		this.constructor._notifyProperties(alerts);
	},

	/**
	 * A convenience method to remove an item from a hasMany relationship. This will
	 * ensure that all of the proper observers are notified of the change.
	 *
	 * @param {String} relationship The relationship to modify
	 * @param {String} id The ID to add to the relationship
	 */
	removeFromRelationship: function(relationship, id) {
		var meta = this.constructor.metaForRelationship(relationship);
		Eg.debug.assert('Cannot modify a read-only relationship', meta.readOnly === false);
		if (meta.readOnly) {
			return;
		}

		var r = this._findLinkTo(relationship, id);

		if (r !== null) {
			switch (r.get('state')) {
				case NEW_STATE:
					this.constructor._notifyProperties(this.get('store')._deleteRelationship(r.get('id')));
					break;
				case SAVED_STATE:
					this.constructor._notifyProperties(
						this.get('store')._changeRelationshipState(r.get('id'), DELETED_STATE));
					break;
				case DELETED_STATE:
					// NOP?
					break;
			}
		}
	},

	/**
	 * Sets the value of a belongsTo relationship to the given ID.
	 *
	 * @param {String} relationship
	 * @param {String} id
	 */
	setBelongsTo: function(relationship, id) {
		var alerts = [];
		var meta = this.constructor.metaForRelationship(relationship);
		Eg.debug.assert('Cannot modify a read-only relationship', meta.readOnly === false);
		if (meta.readOnly) {
			return;
		}

		var link = this._findLinkTo(relationship, id);
		if (link && (link.get('state') === NEW_STATE || link.get('state') === SAVED_STATE)) {
			return;
		}

		if (link && link.get('state') === DELETED_STATE) {
			alerts = alerts.concat(this.get('store')._changeRelationshipState(link.get('id'), SAVED_STATE));
			this.constructor._notifyProperties(alerts);
			return;
		}

		if (id === null) {
			return;
		}

		if (id === null) {
			this.clearBelongsTo(relationship);
			return;
		}

		alerts = alerts.concat(this.clearBelongsTo(relationship, true));

		var store = this.get('store');
		var conflict = this._belongsToConflict(relationship, id);
		if (conflict !== null) {
			switch (conflict.get('state')) {
				case DELETED_STATE:
					// NOP
					break;
				case SAVED_STATE:
					alerts = alerts.concat(store._changeRelationshipState(conflict.get('id'), DELETED_STATE));
					break;
				case NEW_STATE:
					alerts = alerts.concat(store._deleteRelationship(conflict.get('id')));
					break;
			}
		}

		alerts = alerts.concat(store._createRelationship(this.typeKey, relationship,
			this.get('id'), meta.relatedType, meta.inverse, id, NEW_STATE));

		this.constructor._notifyProperties(alerts);
	},

	/**
	 * Sets the value of a belongsTo relationship to `null`.
	 *
	 * @param {String} relationship
	 * @param {Boolean} [suppressNotifications]
	 * @return {Object[]} Objects and properties to notify
	 */
	clearBelongsTo: function(relationship, suppressNotifications) {
		var alerts = [];
		var meta = this.constructor.metaForRelationship(relationship);
		Eg.debug.assert('Cannot modify a read-only relationship', meta.readOnly === false);
		if (meta.readOnly) {
			return [];
		}

		var current = this._belongsToValue(relationship);

		if (current !== null) {
			var r = this._findLinkTo(relationship, current);

			if (r !== null) {
				switch (r.get('state')) {
					case NEW_STATE:
						alerts = alerts.concat(this.get('store')._deleteRelationship(r.get('id')));
						break;
					case SAVED_STATE:
						alerts = alerts.concat(this.get('store')._changeRelationshipState(r.get('id'), DELETED_STATE));
						break;
					case DELETED_STATE:
						// NOP?
						break;
				}
			}
		}

		if (suppressNotifications) {
			return alerts;
		} else {
			this.constructor._notifyProperties(alerts);
			return [];
		}
	},

	/**
	 * If this record is linked to the given record via the given ID, this returns
	 * the relationship that links the two. If they aren't linked, it returns null.
	 *
	 * @param {String} relationship
	 * @param {String} id
	 * @returns {Relationship}
	 * @private
	 */
	_findLinkTo: function(relationship, id) {
		var relationships = this._getAllRelationships();
		for (var i = 0; i < relationships.length; i = i + 1) {
			if (relationships[i].relationshipName(this) === relationship && relationships[i].otherId(this) === id) {
				return relationships[i];
			}
		}

		return null;
	},

	/**
	 * Determines if this record is linked to the given ID via the given relationship.
	 * This will search all relationships: saved, deleted and new
	 *
	 * @param {String} relationship
	 * @param {String} id
	 * @returns {Boolean}
	 */
	_isLinkedTo: function(relationship, id) {
		return this._findLinkTo(relationship, id) !== null;
	},

	/**
	 * Given a relationship name, returns all current relationships associated with that name.
	 *
	 * @param {String} relationship
	 * @returns {Relationship[]}
	 * @private
	 */
	_relationshipsForName: function(relationship) {
		var current = this._getAllRelationships();

		return current.filter(function(r) {
			return (r.relationshipName(this) === relationship);
		}, this);
	},

	/**
	 * Connects the given relationship blindly. Will not check to see if the
	 * relationship is already connected, that should have done beforehand.
	 * Relies on the relationship state to find the relationship.
	 *
	 * @param {Relationship} relationship
	 * @returns {Object} The objects to alert of changes, along with the corresponding property
	 */
	_connectRelationship: function(relationship) {
		var hash = Eg.Relationship.stateToHash(relationship.get('state'));
		this.set(hash + '.' + relationship.get('id'), relationship);
		return { record: this, property: hash };
	},

	/**
	 * Disconnects the relationship from this record.
	 * Relies on the relationship state to find the relationship.
	 *
	 * @param {Relationship} relationship
	 * @returns {Object} The object to alert of changes, along with the corresponding property
	 */
	_disconnectRelationship: function(relationship) {
		var hash = Eg.Relationship.stateToHash(relationship.get('state'));
		delete this.get(hash)[relationship.get('id')];
		return { record: this, property: hash };
	}
});