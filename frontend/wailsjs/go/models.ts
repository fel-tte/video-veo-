export namespace api {
	
	export class CreditsResponse {
	    credits: number;
	    userPaygateTier: string;
	    sku: string;
	    serviceTier: string;
	
	    static createFrom(source: any = {}) {
	        return new CreditsResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.credits = source["credits"];
	        this.userPaygateTier = source["userPaygateTier"];
	        this.sku = source["sku"];
	        this.serviceTier = source["serviceTier"];
	    }
	}

}

export namespace chrome {
	
	export class BrowserInfo {
	    status: string;
	    control_url: string;
	    debug_port: number;
	    profile_dir: string;
	    chrome_path: string;
	
	    static createFrom(source: any = {}) {
	        return new BrowserInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.status = source["status"];
	        this.control_url = source["control_url"];
	        this.debug_port = source["debug_port"];
	        this.profile_dir = source["profile_dir"];
	        this.chrome_path = source["chrome_path"];
	    }
	}

}

export namespace config {
	
	export class AppConfig {
	    chrome_path: string;
	    user_data_dir: string;
	    download_dir: string;
	    min_delay_seconds: number;
	    max_delay_seconds: number;
	    max_retries: number;
	    show_browser: boolean;
	    debug_port: number;
	    model: string;
	    aspect_ratio: string;
	    output_count: number;
	
	    static createFrom(source: any = {}) {
	        return new AppConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.chrome_path = source["chrome_path"];
	        this.user_data_dir = source["user_data_dir"];
	        this.download_dir = source["download_dir"];
	        this.min_delay_seconds = source["min_delay_seconds"];
	        this.max_delay_seconds = source["max_delay_seconds"];
	        this.max_retries = source["max_retries"];
	        this.show_browser = source["show_browser"];
	        this.debug_port = source["debug_port"];
	        this.model = source["model"];
	        this.aspect_ratio = source["aspect_ratio"];
	        this.output_count = source["output_count"];
	    }
	}

}

export namespace sql {
	
	export class NullString {
	    String: string;
	    Valid: boolean;
	
	    static createFrom(source: any = {}) {
	        return new NullString(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.String = source["String"];
	        this.Valid = source["Valid"];
	    }
	}

}

export namespace storage {
	
	export class Stats {
	    total: number;
	    pending: number;
	    generating: number;
	    completed: number;
	    failed: number;
	
	    static createFrom(source: any = {}) {
	        return new Stats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.total = source["total"];
	        this.pending = source["pending"];
	        this.generating = source["generating"];
	        this.completed = source["completed"];
	        this.failed = source["failed"];
	    }
	}
	export class Task {
	    id: number;
	    prompt: string;
	    status: string;
	    video_path: string;
	    thumbnail_path: string;
	    error_message: string;
	    screenshot_path: string;
	    retry_count: number;
	    max_retries: number;
	    created_at: string;
	    started_at: string;
	    completed_at: string;
	    metadata: string;
	
	    static createFrom(source: any = {}) {
	        return new Task(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.prompt = source["prompt"];
	        this.status = source["status"];
	        this.video_path = source["video_path"];
	        this.thumbnail_path = source["thumbnail_path"];
	        this.error_message = source["error_message"];
	        this.screenshot_path = source["screenshot_path"];
	        this.retry_count = source["retry_count"];
	        this.max_retries = source["max_retries"];
	        this.created_at = source["created_at"];
	        this.started_at = source["started_at"];
	        this.completed_at = source["completed_at"];
	        this.metadata = source["metadata"];
	    }
	}

}

