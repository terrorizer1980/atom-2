"use strict";

const {CompositeDisposable, Disposable, Emitter} = require("atom");
const StrategyManager = require("./strategy-manager.js");
const IconTables = require("./icon-tables.js");
const Options = require("../options.js");
const Storage = require("../storage.js");


class IconDelegate{
	
	constructor(resource){
		this.resource    = resource;
		this.disposables = new CompositeDisposable();
		this.emitter     = new Emitter();
		this.icons       = [];
		this.numIcons    = 0;
		this.deserialise();
	}
	
	
	destroy(){
		if(!this.destroyed){
			this.destroyed = true;
			this.emitter.emit("did-destroy");
			this.emitter.dispose();
			this.emitter = null;
			this.disposables.dispose();
			this.disposables.clear();
			this.disposables = null;
			this.resource = null;
			this.icons = null;
		}
	}
	
	
	onDidDestroy(fn){
		return this.emitter.on("did-destroy", fn);
	}
	
	onDidChangeIcon(fn){
		return this.emitter.on("did-change-icon", fn);
	}
	
	onDidChangeMaster(fn){
		return this.emitter.on("did-change-master", fn);
	}
	
	emitIconChange(from, to){
		if(this.emitter)
			this.emitter.emit("did-change-icon", {from, to});
	}
	
	
	/**
	 * Return the CSS classes for displaying the delegate's icon.
	 *
	 * @return {Array}
	 */
	getClasses(){
		const {resource} = this;
		const isDir = resource.isDirectory;
		
		let {colourMode} = Options;
		if(Options.colourChangedOnly && !resource.vcsStatus)
			colourMode = null;
		
		const icon = this.getCurrentIcon();
		let classes = icon
			? icon.getClass(colourMode, true)
			: isDir ? null : Options.defaultIconClass;
		
		if(resource.symlink){
			const linkClass = "icon-file-symlink-" + (isDir ? "directory" : "file");
			if(classes)
				classes[0] = linkClass;
			else
				classes = [linkClass];
		}
		
		/**
		 * HACK: `appliedClasses` is only stored because we have no control over
		 * when the service consumes icons, and IconNodes need to know which classes
		 * to remove when delegates change.
		 */
		this.appliedClasses = classes;
		
		return classes;
	}
	
	
	/**
	 * Retrieve the delegate's active icon.
	 *
	 * If no icon is found, an attempt is made to locate it.
	 *
	 * @return {Icon}
	 */
	getCurrentIcon(){
		if(this.currentIcon)
			return this.currentIcon;
		
		else{
			if(this.numIcons > 0)
				for(let i = this.icons.length - 1; i >= 0; --i){
					const icon = this.icons[i];
					
					if(icon){
						this.setCurrentIcon(icon, i);
						return icon;
					}
				}
			
			StrategyManager.query(this.resource);
			return this.currentIcon || null;
		}
	}
	
	
	/**
	 * Change the currently-active icon.
	 *
	 * @param {Icon} to
	 * @param {Number} priority
	 * @emits did-change-icon
	 */
	setCurrentIcon(to, priority = null){
		const from = this.currentIcon;
		
		if(from !== to){
			this.currentIcon = to;
			
			if(null !== priority)
				this.currentPriority = priority;
			
			if(null === to && !this.resource.isDirectory)
				to = this.getCurrentIcon();
			
			this.serialise();
			this.emitIconChange(from, to);
		}
	}
	
	
	add(icon, priority){
		if(null == this.icons[priority])
			++this.numIcons;
		
		this.icons[priority] = icon;
		
		if(priority >= this.currentPriority)
			this.setCurrentIcon(icon, priority);
	}
	
	
	remove(icon, priority){
		if(priority && this.icons[priority] === icon){
			this.icons[priority] = null;
			--this.numIcons;
			
			if(this.currentPriority === priority)
				this.setCurrentIcon(null, -1);
		}
	}
	
	
	deserialise(){
		const {icons} = Storage.data;
		const {path, isDirectory} = this.resource;
		const iconList = isDirectory
			? IconTables.directoryIcons
			: IconTables.fileIcons;
		
		if(!icons[path])
			return;
		
		// Deserialising too early; tables haven't loaded yet
		if(!iconList){
			setImmediate(_=> this.deserialise());
			return;
		}
		
		const [
			priority,
			iconIndex,
			iconClass,
			...colourClasses
		] = icons[path];
		
		
		// Verify cache is accurate
		let icon = iconList[iconIndex];
		if(icon && icon.icon === iconClass)
			this.add(icon, priority);
		else
			delete icons[path];
		
		setImmediate(_=> StrategyManager.query(this.resource));
	}
	
	
	serialise(){
		if(!Storage.frozen){
			const {icons} = Storage.data;
			const {path} = this.resource;
			const icon = this.currentIcon;
			
			if(icon){
				const iconList = this.resource.isDirectory
					? IconTables.directoryIcons
					: IconTables.fileIcons;
				
				icons[path] = [
					this.currentPriority,
					iconList.indexOf(icon),
					icon.icon,
					...icon.colour
				];
			}
			else
				delete icons[path];
		}
	}
	
	
	
	
	/**
	 * Parent delegate from which to inherit icons and change events.
	 *
	 * NOTE: Assignment is irrevocable. Surrogate instances cannot be
	 * recovered once bound: only reassigned a different master. This
	 * mechanism exists for symlink use only.
	 *
	 * @param {IconDelegate} input
	 * @emits did-change-master
	 */
	set master(input){
		if(null == input || input.master === this)
			return;
		
		const originalIcon = this.currentIcon;
		let currentIcon    = originalIcon;
		let masterDelegate = null;
		let disposable     = null;
		
		Object.defineProperties(this, {
			currentIcon: {
				get: () => masterDelegate
					? masterDelegate.getCurrentIcon()
					: null
			},
			
			master: {
				get: () => masterDelegate,
				set: to => {
					const from = masterDelegate;
					if((to = to || null) !== from){
						masterDelegate = to;
						
						if(disposable){
							disposable.dispose();
							disposable = null;
						}
						
						if(to)
							disposable = new CompositeDisposable(
								to.onDidDestroy(_=> this.master = null),
								to.onDidChangeMaster(to => this.master = to),
								to.onDidChangeIcon(change => {
									const {from, to} = change;
									this.emitIconChange(from, to);
								})
							);
						
						if(this.emitter)
							this.emitter.emit("did-change-master", {from, to});
						
						to = this.currentIcon;
						this.emitIconChange(currentIcon, to);
					}
				}
			}
		});
		
		this.master = input;
	}
}


IconDelegate.prototype.destroyed = false;
IconDelegate.prototype.currentIcon = null;
IconDelegate.prototype.currentPriority = -1;
IconDelegate.prototype.master = null;

module.exports = IconDelegate;